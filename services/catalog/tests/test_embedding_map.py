import time
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from qdrant_client import models

from catalog.api import create_app
from catalog.browser import decode_cursor, encode_cursor
from catalog.embedding_map import PAGE_SIZE, fit_projection
from catalog.indexer import index_batch
from catalog.model import DIMENSIONS, point_id


def test_projection_is_deterministic_finite_centered_and_retains_signal():
    rng = np.random.default_rng(7)
    latent = rng.normal(size=(80, 2)) * [4, 2]
    vectors = np.zeros((80, DIMENSIONS))
    vectors[:, :2] = latent
    center, basis, variance = fit_projection(vectors)
    projected = (vectors - center) @ basis
    assert projected.shape == (80, 2)
    assert np.isfinite(projected).all()
    assert np.allclose(projected.mean(axis=0), [0, 0])
    assert variance == pytest.approx(1)
    for left, right in zip(fit_projection(vectors), (center, basis, variance), strict=True):
        assert np.allclose(left, right)


def test_projection_handles_empty_singleton_and_rejects_nonfinite():
    for data in ([], [np.ones(DIMENSIONS)]):
        center, basis, variance = fit_projection(data)
        assert center.shape == (DIMENSIONS,)
        assert basis.shape == (DIMENSIONS, 2)
        assert np.isfinite(basis).all() and variance == 0
    with pytest.raises(ValueError, match="Nonfinite"):
        fit_projection([[float("nan")] * DIMENSIONS])


@pytest.mark.integration
def test_map_uses_real_vectors_preserves_scope_and_excludes_stale(
    store, vectors, embeddings, song, monkeypatch
):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        data = client.get("/v1/console/embedding-map").json()
        assert data["records"][0]["key"] == song.key
        assert data["projection"]["method"] == "sample-pca-v1"
        assert data["projection"]["fitted_records"] == 1
        assert data["catalog_records"] == data["catalog_indexed"] == 1
        assert data["scanned"] == 1 and data["next"] is None
        assert "not audio similarity" in data["notice"]
        assert all(np.isfinite(data["records"][0][axis]) for axis in ("x", "y"))
        with store.transaction() as conn:
            conn.execute("UPDATE entities SET revision=revision+1 WHERE key=%s", (song.key,))
        stale = client.get("/v1/console/embedding-map").json()
        assert stale["records"] == [] and stale["stale_skipped"] == 1
        assert client.get("/v1/console/embedding-map?kind=genre").status_code == 422
        assert client.get("/v1/console/embedding-map?source=unknown").status_code == 422
        assert client.get("/v1/console/embedding-map?after=bad").status_code == 422
        broken = encode_cursor(["embedding-map", None, None], ["missing", "not-a-uuid"])
        assert client.get("/v1/console/embedding-map", params={"after": broken}).status_code == 422


@pytest.mark.integration
def test_projection_pages_reuse_basis_filter_scope_and_expire(
    store, vectors, embeddings, song, monkeypatch
):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    original = vectors.client.scroll
    calls = []

    def scroll(**kwargs):
        calls.append(kwargs)
        models.ScrollRequest(offset=kwargs.get("offset"), limit=kwargs["limit"])
        points, _ = original(**{**kwargs, "offset": None})
        return points, point_id(song.key) if kwargs.get("offset") is None else None

    monkeypatch.setattr(vectors.client, "scroll", scroll)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        first = client.get("/v1/console/embedding-map", params={"source": "musicbrainz"}).json()
        second = client.get("/v1/console/embedding-map", params={
            "source": "musicbrainz", "after": first["next"],
        }).json()
        assert second["projection"]["id"] == first["projection"]["id"]
        assert second["records"] == first["records"] and second["next"] is None
        assert calls[0]["limit"] == PAGE_SIZE and calls[0]["with_vectors"] is True
        assert isinstance(calls[1]["offset"], str)
        assert calls[0]["scroll_filter"].must[0].match.value == "musicbrainz"
        assert client.get("/v1/console/embedding-map", params={
            "source": "apple", "after": first["next"],
        }).status_code == 422
        unknown = encode_cursor(
            ["embedding-map", None, None], [str(uuid.uuid4()), point_id(song.key)]
        )
        assert client.get("/v1/console/embedding-map", params={"after": unknown}).status_code == 409
        before = time.monotonic()
        monkeypatch.setattr("catalog.embedding_map.time.monotonic", lambda: before + 1801)
        assert client.get("/v1/console/embedding-map", params={
            "source": "musicbrainz", "after": first["next"],
        }).status_code == 409
        values = decode_cursor(first["next"], ["embedding-map", "musicbrainz", None])
        assert values[1] == point_id(song.key)


@pytest.mark.integration
def test_map_reports_dependency_failures_instead_of_empty_success(
    store, vectors, embeddings, monkeypatch
):
    def unavailable(**kwargs):
        raise ValueError("Incompatible fixture vectors")

    monkeypatch.setattr(vectors.client, "scroll", unavailable)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        response = client.get("/v1/console/embedding-map")
        assert response.status_code == 503
        assert "dependency unavailable" in response.json()["detail"]
