import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.console import snapshot
from catalog.indexer import index_batch
from test_youtube import CHANNEL, VIDEO, feed


pytestmark = pytest.mark.integration


def test_console_reports_full_parallel_pool_ahead_of_stopped_workers(store):
    with store.transaction() as conn:
        for role, count in (("crawler", 32), ("indexer", 8), ("ranker", 1)):
            for _ in range(count):
                conn.execute(
                    "INSERT INTO workers(id,role,state) VALUES (%s,%s,'idle')",
                    (uuid.uuid4(), role),
                )
        for _ in range(65):
            conn.execute(
                "INSERT INTO workers(id,role,state) VALUES (%s,'crawler','stopped')",
                (uuid.uuid4(),),
            )
    workers = snapshot(store)["workers"]
    assert len(workers) == 100
    assert sum(worker["alive"] for worker in workers) == 41
    assert all(worker["alive"] for worker in workers[:41])


def test_console_serves_local_assets_live_snapshot_and_graph(store, vectors, embeddings, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        store.activity(conn, "crawler", "crawled", "Fixture observation", source="musicbrainz")
    store.heartbeat(uuid.uuid4(), "crawler", "idle")
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        home = client.get("/")
        assert home.status_code == 200 and "Catalog observatory" in home.text
        assert "frame-ancestors 'none'" in home.headers["content-security-policy"]
        assert client.get("/console/console.js").status_code == 200
        assert client.get("/console/console.css").status_code == 200
        assert "/console/cytoscape.min.js" in home.text
        assert 'id="graph-layout"' in home.text
        assert 'id="focus-graph"' in home.text
        assert 'value="embeddings">Embedding Atlas' in home.text
        for asset in (
            "cytoscape.min.js", "graph-view.js", "cytoscape.LICENSE.txt",
            "embedding-map.js", "embedding-atlas.js", "embedding-atlas.LICENSE.txt",
        ):
            response = client.get(f"/console/{asset}")
            assert response.status_code == 200
        assert "Permission is hereby granted" in client.get("/console/cytoscape.LICENSE.txt").text
        assert "script-src 'self';" in home.headers["content-security-policy"]
        assert "'unsafe-eval'" not in home.headers["content-security-policy"]
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").status_code == 200
        assert client.get("/console/../../schema.sql").status_code == 404
        data = client.get("/v1/console/snapshot").json()
        assert data["entities"] == 1 and data["indexed"] == 0
        assert any(worker["role"] == "crawler" and worker["alive"] for worker in data["workers"])
        assert len(data["activity"]) == 1
        with client.websocket_connect(
            "/v1/console/live", headers={"origin": "http://testserver"}
        ) as ws:
            message = ws.receive_json()
            assert message["type"] == "snapshot"
            assert message["data"]["entities"] == 1
        assert client.get(f"/v1/console/graph/{song.key}").json()["nodes"][0]["key"] == song.key


def test_controls_require_local_origin_token_and_cannot_enable_disabled_sources(
    store,
    vectors,
    embeddings,
):
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        payload = {"source": "youtube", "kind": "song", "identifier": VIDEO}
        assert client.post("/v1/console/seed", json=payload).status_code == 403
        token = client.get("/v1/console/session").json()["token"]
        headers = {"X-Console-Token": token}
        assert client.post("/v1/console/seed", json=payload, headers=headers).status_code == 409
        assert (
            client.post(
                "/v1/console/sources/musicbrainz",
                json={"paused": True},
                headers={**headers, "Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert client.get("/", headers={"Host": "evil.example"}).status_code == 400
        assert (
            client.post(
                "/v1/console/sources/musicbrainz",
                json={"paused": True},
                headers=headers,
            ).status_code
            == 200
        )
        with store.transaction() as conn:
            store.enqueue(
                conn, "mb-lookup", "global", "song", "00000000-0000-4000-8000-000000000003"
            )
        assert store.claim() == []
        assert (
            client.post(
                "/v1/console/sources/musicbrainz",
                json={"paused": False},
                headers=headers,
            ).status_code
            == 200
        )
        assert len(store.claim()) == 1


def test_operator_seeds_retry_and_source_identity_flow(store, vectors, embeddings):
    store.settings = replace(store.settings, youtube_enabled=True, ytmusic_enabled=True)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        headers = {"X-Console-Token": client.get("/v1/console/session").json()["token"]}
        response = client.post(
            "/v1/console/seed",
            headers=headers,
            json={
                "source": "youtube",
                "kind": "artist",
                "identifier": CHANNEL,
            },
        )
        assert response.status_code == 202, response.text
        job = store.claim()[0]
        assert job["source"] == "youtube" and job["task"] == "yt-feed"
        store.fail(job, "FixtureFailure", 60)
        assert (
            client.post(
                "/v1/console/retry",
                headers=headers,
                json={"queue": "jobs", "key": job["key"]},
            ).status_code
            == 200
        )
        assert len(store.claim()) == 1
        assert (
            client.post(
                "/v1/console/seed",
                headers=headers,
                json={
                    "source": "youtube",
                    "kind": "album",
                    "identifier": VIDEO,
                },
            ).status_code
            == 422
        )


def test_source_metrics_stay_exact_during_revision_reindexing(store, song, vectors, embeddings):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    data = snapshot(store)
    assert data["entities"] == data["indexed"] == 1
    with store.transaction() as conn:
        store.ingest(conn, [replace(song, title="Updated Title")])
    assert snapshot(store)["indexed"] == 0
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    assert snapshot(store)["indexed"] == 1
    store.reindex_batch()
    assert snapshot(store)["indexed"] == 0
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    assert snapshot(store)["indexed"] == 1


def test_youtube_pipeline_views_graph_search_and_activity(store, vectors, embeddings):
    from catalog.crawler import process
    from unittest.mock import Mock

    store.settings = replace(store.settings, youtube_enabled=True)
    with store.transaction() as conn:
        store.enqueue(conn, "yt-feed", "global", "artist", CHANNEL)
    sources = Mock()
    sources.fetch.return_value = {"xml": feed()}
    process(store, sources, store.claim()[0])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    with store.transaction() as conn:
        signal = conn.execute("SELECT signal_kind,raw_value,rank FROM chart_signals").fetchone()
        assert signal == {"signal_kind": "views", "raw_value": 12345, "rank": None}
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        result = client.get("/v1/search", params={"q": "Fixture", "source": "youtube"}).json()
        assert len(result["results"]) == 2
        assert all(row["source"] == "youtube" for row in result["results"])
    data = snapshot(store)
    assert data["entities"] == data["indexed"] == 2
    assert {event["action"] for event in data["activity"]} == {"crawled", "indexed"}


def test_v1_migration_preserves_existing_data_and_bootstraps_counters(store):
    # A separate empty database is already owned by this fixture.
    with store.transaction() as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        conn.execute(Path(__file__).parents[1].joinpath("catalog/schema.sql").read_text())
        conn.execute(
            """INSERT INTO entities(key,source,origin,quality,country,kind,provider_id,
               title,artist,album,genres,url,document,indexed_revision)
               VALUES ('apple:us:song:123','apple','apple',1,'us','song','123',
               'Preserved','Artist','Album','{}','https://music.apple.com/test','Preserved',NULL)"""
        )
        conn.execute("UPDATE catalog_budget SET entities=1")
    store.migrate()
    store.migrate()
    with store.transaction() as conn:
        assert conn.execute("SELECT title FROM entities").fetchone()["title"] == "Preserved"
        assert conn.execute("SELECT entities FROM source_metrics").fetchone()["entities"] == 1
        assert (
            conn.execute("SELECT max(version) AS version FROM catalog_schema").fetchone()["version"]
            == 9
        )
