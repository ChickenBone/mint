from dataclasses import replace

import pytest

from catalog.model import (
    apple_url,
    chart_entities,
    chart_weight,
    entity_key,
    fuse,
    listenbrainz_entities,
    lookup_entities,
    musicbrainz_entity,
    point_id,
)
from conftest import ALBUM_ID, ARTIST_ID, SONG_ID


def chart():
    return {
        "feed": {
            "country": "us",
            "results": [
                {
                    "id": "123",
                    "kind": "songs",
                    "name": "First Song",
                    "artistName": "An Artist",
                    "artistId": "456",
                    "url": "https://music.apple.com/us/album/first/789?i=123",
                    "genres": [{"name": "Rock"}],
                }
            ],
        }
    }


def test_scoped_ids_never_merge_names_or_storefronts():
    assert entity_key("us", "song", "123") != entity_key("gb", "song", "123")
    assert entity_key("global", "song", SONG_ID, "musicbrainz").startswith("musicbrainz:")
    assert point_id("a") == point_id("a")
    assert point_id("a") != point_id("b")
    for country, source, identifier in [
        ("global", "apple", "123"),
        ("us", "musicbrainz", SONG_ID),
        ("us", "apple", "../123"),
        ("global", "musicbrainz", "not-a-uuid"),
    ]:
        with pytest.raises(ValueError):
            entity_key(country, "song", identifier, source)


def test_chart_rank_is_preserved_and_entities_are_minimal():
    entities = chart_entities(chart(), "us")
    assert entities[0].quality == 0
    assert entities[0].artist_keys == ("apple:us:artist:456",)
    assert "preview" not in entities[0].document()
    with pytest.raises(ValueError, match="storefront"):
        chart_entities(chart(), "gb")
    duplicate = chart()
    duplicate["feed"]["results"] *= 2
    with pytest.raises(ValueError, match="Duplicate"):
        chart_entities(duplicate, "us")


def test_lookup_rejects_unexpected_kinds_and_result_counts():
    with pytest.raises(ValueError):
        lookup_entities({"resultCount": 1, "results": []}, "us")
    with pytest.raises(ValueError, match="kind"):
        lookup_entities({"resultCount": 1, "results": [{"wrapperType": "podcast"}]}, "us")


def test_attribution_urls_cannot_point_to_other_hosts():
    for url in [
        "http://music.apple.com/a",
        "https://music.apple.com.evil.example/a",
        "https://user@music.apple.com/a",
        "https://music.apple.com:444/a",
    ]:
        with pytest.raises(ValueError):
            apple_url(url)


def test_mb_explicit_collaborators_and_album_relationships():
    entity = musicbrainz_entity(
        "song",
        {
            "id": SONG_ID,
            "title": "Original",
            "artist-credit": [
                {"name": "First", "joinphrase": " & ", "artist": {"id": ARTIST_ID}},
                {"name": "Second", "artist": {"id": ALBUM_ID}},
            ],
            "releases": [{"release-group": {"id": ALBUM_ID}}],
        },
    )
    assert entity.source == entity.origin == "musicbrainz"
    assert entity.artist == "First & Second"
    assert len(entity.artist_keys) == 2
    assert entity.album_keys == (f"musicbrainz:global:album:{ALBUM_ID}",)


@pytest.mark.parametrize("kind", ["artist", "album", "song"])
def test_musicbrainz_preserves_public_genres_not_arbitrary_tags(kind):
    row = {
        "id": ARTIST_ID,
        "title": "Synthetic",
        "name": "Synthetic",
        "genres": [
            {"name": "Electronic", "count": 10},
            {"name": "Ambient", "count": 2},
            {"name": "Electronic", "count": 1},
        ],
        "tags": [{"name": "seen live"}],
    }
    entity = musicbrainz_entity(kind, row)
    assert entity.genres == ("Electronic", "Ambient")
    assert "seen live" not in entity.document()
    assert "Electronic" in entity.document()
    assert musicbrainz_entity(kind, {k: v for k, v in row.items() if k != "genres"}).genres == ()
    for genres in (None, {}, [{"name": "a"}] * 101, [{"name": ""}]):
        with pytest.raises(ValueError):
            musicbrainz_entity(kind, {**row, "genres": genres})


def test_listenbrainz_uses_explicit_mbids_not_title_guessing():
    entities = listenbrainz_entities(
        {
            "payload": {
                "range": "week",
                "recordings": [
                    {"track_name": "Unknown", "recording_mbid": ""},
                    {
                        "track_name": "Known",
                        "artist_name": "Artist",
                        "recording_mbid": SONG_ID,
                        "artist_mbids": [ARTIST_ID],
                        "listen_count": 5,
                    },
                ],
            }
        }
    )
    entity, rank = entities[0]
    assert rank == 2
    assert entity.origin == "listenbrainz" and entity.source == "musicbrainz"
    assert entity.quality == 0


def test_rrf_deduplicates_and_combines_rankings():
    assert fuse(["a", "a", "b"], ["b", "c"], 2)[0][0] == "b"
    assert len(fuse(["a"], ["a"], 50)) == 1
    assert chart_weight(1) > chart_weight(100) > 0
    with pytest.raises(ValueError):
        chart_weight(0)


def test_embedding_document_is_metadata_not_media(song):
    assert "Northern Lights" in song.document()
    assert song.document() == replace(song, url="https://example.org").document()
