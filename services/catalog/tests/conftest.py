import os
import uuid
import warnings
from dataclasses import replace

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from qdrant_client import QdrantClient

from catalog.config import Settings
from catalog.model import DIMENSIONS, Entity, entity_key
from catalog.store import Store
from catalog.vectors import Embeddings, Vectors


ARTIST_ID = "00000000-0000-4000-8000-000000000001"
ALBUM_ID = "00000000-0000-4000-8000-000000000002"
SONG_ID = "00000000-0000-4000-8000-000000000003"


@pytest.fixture
def settings():
    return Settings(
        database_url="postgresql://unused/unused",
        qdrant_url="http://unused:6333",
        countries=("us", "gb"),
        apple_enabled=True,
        musicbrainz_enabled=True,
        listenbrainz_enabled=True,
        user_agent="CatalogTests/0.1 (https://example.org)",
        model_cache="/unused",
        collection="catalog_test",
        max_entities=1000,
        source_interval=4,
        chart_interval=21600,
    )


@pytest.fixture
def song():
    return Entity(
        entity_key("global", "song", SONG_ID, "musicbrainz"),
        "global",
        "song",
        SONG_ID,
        "Northern Lights",
        "Example Artist",
        "",
        (),
        f"https://musicbrainz.org/recording/{SONG_ID}",
        (entity_key("global", "artist", ARTIST_ID, "musicbrainz"),),
        (entity_key("global", "album", ALBUM_ID, "musicbrainz"),),
        source="musicbrainz",
        origin="musicbrainz",
    )


@pytest.fixture
def store(settings):
    admin = os.getenv("CATALOG_TEST_DATABASE_URL")
    if not admin:
        pytest.skip(
            "Set CATALOG_TEST_DATABASE_URL to an isolated local PostgreSQL admin connection"
        )
    # Never truncate or migrate a supplied database: own a new, uniquely named test database.
    name = f"mint_catalog_test_{uuid.uuid4().hex}"
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    params = conninfo_to_dict(admin)
    params["dbname"] = name
    instance = Store(replace(settings, database_url=make_conninfo(**params)))
    try:
        instance.migrate()
        yield instance
    finally:
        instance.close()
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


@pytest.fixture
def vectors(settings):
    remote = os.getenv("CATALOG_TEST_QDRANT_URL")
    client = QdrantClient(url=remote) if remote else QdrantClient(":memory:")
    instance = Vectors(replace(settings, collection=f"catalog_test_{uuid.uuid4().hex}"), client)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Payload indexes have no effect")
        instance.initialize()
    try:
        yield instance
    finally:
        client.delete_collection(instance.collection)
        instance.close()


class FixtureEmbeddings:
    def documents(self, documents):
        return [[1.0, *([0.0] * (DIMENSIONS - 1))] for _ in documents]

    def query(self, query):
        return self.documents([query])[0]


@pytest.fixture(scope="session")
def embeddings():
    if cache := os.getenv("CATALOG_TEST_MODEL_CACHE"):
        return Embeddings(cache)
    return FixtureEmbeddings()
