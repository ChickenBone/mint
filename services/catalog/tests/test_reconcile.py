from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.reconcile import RecordingQuery, assess, normalize, reconcile
from catalog.youtube import Discovery


def candidate(song, **extra):
    return {
        "key": song.key,
        "source": song.source,
        "provider_id": song.provider_id,
        "title": song.title,
        "artist": song.artist,
        "album": song.album,
        "url": song.url,
        "observed_at": None,
        "metadata": {},
        **extra,
    }


@pytest.mark.parametrize(
    ("title", "artist", "candidate_title", "candidate_artist", "conflicts"),
    [
        ("Northern Lights", "Example Artist", "Northern Lights", "Example Artist", []),
        ("Nórthern Lights", "EXAMPLE Artist", "Northern Lights", "Example Artist", []),
        (
            "Northern Lights",
            "Example Artist",
            "Northern Lights (Live)",
            "Example Artist",
            ["title_mismatch", "version_mismatch"],
        ),
        (
            "Northern Lights",
            "Example Artist",
            "Northern Lights (Remix)",
            "Example Artist",
            ["title_mismatch", "version_mismatch"],
        ),
        (
            "Northern Lights",
            "Example Artist",
            "Northern Lights",
            "Unrelated Artist",
            ["artist_mismatch"],
        ),
    ],
)
def test_labeled_recording_relevance_cases(
    song, title, artist, candidate_title, candidate_artist, conflicts
):
    result = assess(
        RecordingQuery(title=title, artist=artist),
        candidate(song, title=candidate_title, artist=candidate_artist),
        [],
    )
    assert result["conflicts"] == conflicts
    assert result["match_type"] == "metadata_candidate"
    assert result["review_required"]
    assert "probability" not in result


def test_duration_conflict_cannot_be_a_clean_identifier_match(song):
    result = assess(
        RecordingQuery(title=song.title, artist=song.artist, duration_ms=180000),
        candidate(song, metadata={"duration_ms": 240000}),
        [{"code": "provider_id"}],
    )
    assert result["review_required"]
    assert result["conflicts"] == ["duration_mismatch"]
    assert normalize("Årtist & Name") == "artist name"


@pytest.mark.integration
def test_authority_recording_links_work_in_both_directions_without_merging(store, song):
    other = replace(
        song,
        key="deezer:global:song:123",
        provider_id="123",
        source="deezer",
        origin="deezer",
        url="https://www.deezer.com/track/123",
    )
    with store.transaction() as conn:
        store.ingest(conn, [song, other], schedule=False)
        store.public_observations(
            conn,
            Discovery(
                [],
                [],
                [],
                [],
                links=[
                    (song.key, "deezer", "song", "123", other.url),
                ],
            ),
            schedule=False,
        )
    for source, identifier in (("musicbrainz", song.provider_id), ("deezer", "123")):
        with store.transaction() as conn:
            result = reconcile(
                conn,
                RecordingQuery(
                    title=song.title,
                    artist=song.artist,
                    references=[{"source": source, "identifier": identifier}],
                ),
            )
        assert result["status"] == "identified"
        assert {row["key"] for row in result["candidates"]} == {song.key, other.key}
        assert all(row["match_type"] == "explicit_identifier" for row in result["candidates"])
        assert any(
            e["code"] == "authority_link" for row in result["candidates"] for e in row["evidence"]
        )
        assert not result["automatic_merge"]
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 2
        assert conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"] == 0


@pytest.mark.integration
def test_excluded_links_and_non_authorities_cannot_establish_recording_identity(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song], schedule=False)
        conn.execute(
            """INSERT INTO entity_links(key,provider,kind,identifier,url,canonical_status)
               VALUES (%s,'deezer','song','123','https://www.deezer.com/track/123','excluded')""",
            (song.key,),
        )
        result = reconcile(
            conn,
            RecordingQuery(
                references=[{"source": "deezer", "identifier": "123"}],
            ),
        )
        assert result["status"] == "no_match"


@pytest.mark.integration
def test_conflicting_authorities_are_ambiguous_not_unioned(store, song):
    other_id = "00000000-0000-4000-8000-000000000099"
    other = replace(song, key=f"musicbrainz:global:song:{other_id}", provider_id=other_id)
    with store.transaction() as conn:
        store.ingest(conn, [song, other], schedule=False)
        for item in (song, other):
            conn.execute(
                """INSERT INTO entity_links(key,provider,kind,identifier,url)
                   VALUES (%s,'deezer','song','123','https://www.deezer.com/track/123')""",
                (item.key,),
            )
        result = reconcile(
            conn,
            RecordingQuery(
                references=[{"source": "deezer", "identifier": "123"}],
            ),
        )
    assert result["status"] == "ambiguous"
    assert result["conflicts"] == ["multiple_authority_recordings"]
    assert result["review_required"]


@pytest.mark.integration
def test_popular_metadata_window_does_not_invalidate_consistent_identifier_evidence(store, song):
    songs = [song]
    for number in range(100, 160):
        songs.append(
            replace(
                song,
                key=f"deezer:global:song:{number}",
                provider_id=str(number),
                source="deezer",
                origin="deezer",
            )
        )
    with store.transaction() as conn:
        store.ingest(conn, songs, schedule=False)
        result = reconcile(
            conn,
            RecordingQuery(
                title=song.title,
                artist=song.artist,
                references=[{"source": "musicbrainz", "identifier": song.provider_id}],
            ),
        )
    assert result["status"] == "identified"
    assert not result["review_required"]
    assert result["candidates_truncated"]


@pytest.mark.integration
def test_non_authority_crosswalks_remain_unverified(store, song):
    other = replace(
        song,
        key="deezer:global:song:123",
        provider_id="123",
        source="deezer",
        origin="deezer",
    )
    with store.transaction() as conn:
        store.ingest(conn, [other], schedule=False)
        conn.execute(
            """INSERT INTO entity_links(key,provider,kind,identifier,url)
               VALUES (%s,'spotify','song',%s,'https://example.org')""",
            (other.key, "a" * 22),
        )
        result = reconcile(
            conn,
            RecordingQuery(
                references=[{"source": "spotify", "identifier": "a" * 22}],
            ),
        )
    assert result["status"] == "no_match"


@pytest.mark.integration
def test_metadata_exact_match_stays_a_candidate_and_api_validates_input(
    store,
    song,
    vectors,
    embeddings,
):
    with store.transaction() as conn:
        store.ingest(conn, [song], schedule=False)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        response = client.post(
            "/v1/reconcile/recordings",
            json={
                "title": song.title,
                "artist": song.artist,
            },
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        result = response.json()
        assert result["status"] == "candidates"
        assert result["candidates"][0]["key"] == song.key
        assert result["candidates"][0]["review_required"]
        for payload in (
            {},
            {"title": "   ", "artist": "   "},
            {"references": [{"source": "apple", "identifier": "123"}]},
            {"references": [{"source": "discogs", "identifier": "123"}]},
        ):
            assert client.post("/v1/reconcile/recordings", json=payload).status_code == 422
        assert (
            client.post(
                "/v1/reconcile/recordings",
                json={
                    "references": [{"source": "deezer", "identifier": "999"}],
                },
            ).json()["status"]
            == "no_match"
        )
        assert (
            client.post(
                "/v1/reconcile/recordings",
                content=iter([b" " * 16385] * 2),
            ).status_code
            == 413
        )
