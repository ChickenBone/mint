import base64
import json
from dataclasses import replace
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.browser import TABLES, decode_cursor, encode_cursor, typed
from catalog.indexer import index_batch
from catalog.model import DIMENSIONS, point_id


@pytest.mark.parametrize(
    "value,kind",
    [
        (True, "bigint"),
        ("-1", "integer"),
        (2**63, "bigint"),
        ({}, "uuid"),
        ([], "text"),
        ("bad", "boolean"),
        ("x" * 301, "text"),
    ],
)
def test_invalid_primary_keys_rejected(value, kind):
    with pytest.raises(HTTPException) as error:
        typed(value, kind)
    assert error.value.status_code == 422


def test_cursor_is_scoped_to_dataset_and_filter():
    cursor = encode_cursor(["postgres", "entities", None], ["key"])
    assert decode_cursor(cursor, ["postgres", "entities", None]) == ["key"]
    for bad in ("not-base64", base64.b64encode(b"[]").decode(), cursor):
        with pytest.raises(HTTPException):
            decode_cursor(bad, ["postgres", "jobs", None])


@pytest.fixture
def client(store, vectors, embeddings):
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as instance:
        yield instance


def test_browser_assets_navigation_and_read_only_contract(client):
    assert client.get("/data").status_code == 200
    for name in ("data.js", "data.css"):
        assert client.get("/console/" + name).status_code == 200
    assert 'href="/data"' in client.get("/").text
    response = client.get("/v1/data/tables")
    assert response.json()["read_only"]
    assert {row["name"] for row in response.json()["tables"]} == set(TABLES)
    for table in response.json()["tables"]:
        assert table["columns"]
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.get("/v1/data/postgres/pg_authid").status_code == 404
    assert client.post("/v1/data/postgres/entities", json={}).status_code == 405
    assert client.delete("/v1/data/vectors/" + str(uuid4())).status_code == 405
    assert client.get("/data", headers={"host": "evil.example"}).status_code == 400


def test_postgres_raw_fields_pagination_filters_and_infinity(client, store, song):
    rows = [
        replace(
            song,
            provider_id=str(UUID(int=i)),
            key=f"fixture-{i:03d}",
            title=f"Fictional Record {i}",
        )
        for i in range(6)
    ]
    with store.transaction() as conn:
        store.ingest(conn, rows)
        store.enqueue(conn, "mb-lookup", "global", song.kind, song.provider_id)
        conn.execute("INSERT INTO host_budgets(host,next_at) VALUES ('fixture.example','infinity')")
    seen = []
    after = None
    for _ in range(3):
        response = client.get(
            "/v1/data/postgres/entities", params={"limit": 2, **({"after": after} if after else {})}
        )
        assert response.status_code == 200
        data = response.json()
        assert [json.loads(raw) for raw in data["raw_rows"]] == data["rows"]
        seen += [row["key"] for row in data["rows"]]
        assert {"document", "search", "quality", "indexed_revision"} <= data["rows"][0].keys()
        after = data["next"]
    assert seen == sorted(row.key for row in rows)
    assert after is None
    data = client.get("/v1/data/postgres/entities", params={"exact": rows[2].key}).json()
    assert [row["key"] for row in data["rows"]] == [rows[2].key]
    assert (
        client.get("/v1/data/postgres/entities", params={"exact": "' OR true --"}).json()["rows"]
        == []
    )
    assert client.get("/v1/data/postgres/jobs").json()["rows"][0]["lease_until"] == "-infinity"
    assert (
        client.get("/v1/data/postgres/host_budgets", params={"exact": "fixture.example"}).json()[
            "rows"
        ][0]["next_at"]
        == "infinity"
    )
    for limit in (0, 51):
        assert client.get("/v1/data/postgres/entities", params={"limit": limit}).status_code == 422
    for cursor in (
        "bad",
        encode_cursor(["postgres", "jobs", None], ["x"]),
        encode_cursor(["postgres", "entities", None], ["x", "y"]),
    ):
        assert client.get("/v1/data/postgres/entities", params={"after": cursor}).status_code == 422


def test_all_postgres_tables_composite_numeric_boolean_uuid_and_empty(client, store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        store.activity(conn, "fixture", "loaded", "Fictional records")
        store.activity(conn, "fixture", "loaded", "Fictional records again")
    store.heartbeat(uuid4(), "fixture", "idle")
    # heartbeat owns a separate transaction; all tables remain independently readable.
    for table in TABLES:
        response = client.get(f"/v1/data/postgres/{table}", params={"limit": 1})
        assert response.status_code == 200, (table, response.text)
        data = response.json()
        if data["next"]:
            following = client.get(
                f"/v1/data/postgres/{table}", params={"limit": 1, "after": data["next"]}
            )
            assert following.status_code == 200
            assert following.json()["rows"] != data["rows"]
    assert client.get("/v1/data/postgres/catalog_budget", params={"exact": "true"}).json()["rows"]
    assert client.get("/v1/data/postgres/activity", params={"exact": "invalid"}).status_code == 422
    assert client.get("/v1/data/postgres/workers", params={"exact": "invalid"}).status_code == 422
    # Two edges share a source; paging must compare both primary-key columns.
    first = client.get("/v1/data/postgres/edges", params={"limit": 1}).json()
    second = client.get(
        "/v1/data/postgres/edges", params={"limit": 1, "after": first["next"]}
    ).json()
    assert first["rows"][0]["target"] != second["rows"][0]["target"]
    assert client.get("/v1/data/postgres/entity_annotations").json()["rows"] == []


def test_raw_inspector_preserves_large_integer_precision(client, store):
    with store.transaction() as conn:
        conn.execute(
            """INSERT INTO activity(id,role,action,detail)
               VALUES (9007199254740993,'fixture','loaded','Fictional precision fixture')"""
        )
    data = client.get("/v1/data/postgres/activity").json()
    assert '"id": 9007199254740993' in data["raw_rows"][0]


def test_qdrant_scroll_payloads_full_vector_and_missing_point(
    client, store, vectors, embeddings, song
):
    with store.transaction() as conn:
        store.ingest(conn, [song, replace(song, key="second", provider_id=str(uuid4()))])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 50))
    first = client.get("/v1/data/vectors", params={"limit": 1}).json()
    assert first["collection"] == vectors.collection
    assert first["dimensions"] == DIMENSIONS
    assert first["reported_points"] == 2
    assert first["next"]
    assert "vector" not in first["rows"][0]
    second = client.get("/v1/data/vectors", params={"limit": 1, "after": first["next"]}).json()
    assert first["rows"][0]["id"] != second["rows"][0]["id"]
    assert second["next"] is None
    selected = client.get("/v1/data/vectors/" + str(point_id(song.key))).json()
    assert selected["payload"]["key"] == song.key
    assert len(selected["vector"]) == DIMENSIONS
    assert json.loads(selected["raw_json"])["vector"] == selected["vector"]
    filtered = client.get("/v1/data/vectors", params={"exact": song.key}).json()
    assert len(filtered["rows"]) == 1
    assert filtered["rows"][0]["payload"]["key"] == song.key
    assert client.get("/v1/data/vectors/" + str(uuid4())).status_code == 404
    assert client.get("/v1/data/vectors/not-a-uuid").status_code == 422
    assert client.get("/v1/data/vectors", params={"after": "invalid"}).status_code == 422
    assert client.get("/v1/data/vectors", params={"exact": "missing"}).json()["rows"] == []


def test_vector_failure_does_not_prevent_postgres_browsing(client, vectors):
    with patch.object(vectors.client, "get_collection", side_effect=httpx.ConnectError("fixture")):
        response = client.get("/v1/data/vectors")
        assert response.status_code == 503
        assert "Qdrant unavailable" in response.json()["detail"]
        assert client.get("/v1/data/postgres/catalog_schema").status_code == 200
    with patch.object(vectors.client, "retrieve", side_effect=httpx.ConnectError("fixture")):
        assert client.get("/v1/data/vectors/" + str(uuid4())).status_code == 503
