import re
from typing import Literal
from urllib.parse import urlsplit


EntitySource = Literal[
    "omdb",
    "apple",
    "musicbrainz",
    "youtube",
    "ytmusic",
    "spotify",
    "deezer",
    "archive",
    "wikidata",
    "soundcloud",
    "openverse",
    "discogs",
]
Source = Literal[
    "omdb",
    "apple",
    "musicbrainz",
    "listenbrainz",
    "youtube",
    "ytmusic",
    "spotify",
    "deezer",
    "archive",
    "wikidata",
    "soundcloud",
    "openverse",
    "discogs",
    "openwhyd",
]
PUBLIC_SOURCES = (
    "spotify",
    "deezer",
    "archive",
    "wikidata",
    "soundcloud",
    "openverse",
    "discogs",
    "openwhyd",
)
SOURCES = ("musicbrainz", "listenbrainz", "apple", "youtube", "ytmusic", *PUBLIC_SOURCES, "omdb")
HOSTS = {
    "apple": "itunes.apple.com",
    "musicbrainz": "musicbrainz.org",
    "listenbrainz": "api.listenbrainz.org",
    "youtube": "www.youtube.com",
    "ytmusic": "music.youtube.com",
    "spotify": "open.spotify.com",
    "deezer": "api.deezer.com",
    "archive": "archive.org",
    "wikidata": "www.wikidata.org",
    "soundcloud": "soundcloud.com",
    "openverse": "api.openverse.org",
    "discogs": "api.discogs.com",
    "openwhyd": "openwhyd.org",
}
KINDS = {
    "omdb": ("artist", "album", "song"),
    "spotify": ("artist", "album", "song"),
    "deezer": ("artist", "album", "song"),
    "archive": ("album",),
    "wikidata": ("artist", "album", "song"),
    "soundcloud": ("artist", "song"),
    "openverse": ("song",),
    "discogs": ("artist", "album"),
    "openwhyd": (),
}
# The catalog distinguishes researched options from implemented adapters.
# A documentation link is not a claim that a crawler exists or reuse is unrestricted.
RESEARCH = (
    (
        "omdb",
        "Openmusic Database",
        "bulk",
        "Local PostgreSQL dump metadata import; published download links may expire",
        "https://github.com/OatsCG/OMDB",
    ),
    (
        "musicbrainz",
        "MusicBrainz",
        "adapter",
        "Identity, relationships and paginated metadata",
        "https://musicbrainz.org/doc/MusicBrainz_API",
    ),
    (
        "listenbrainz",
        "ListenBrainz",
        "adapter",
        "Sitewide weekly popularity seeds",
        "https://listenbrainz.readthedocs.io/en/latest/users/api/statistics.html",
    ),
    (
        "apple",
        "Apple Music / iTunes",
        "adapter",
        "Opt-in storefront charts and bounded lookups",
        "https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/",
    ),
    (
        "youtube",
        "YouTube",
        "adapter",
        "Public recent-upload feeds and video oEmbed only",
        "https://www.youtube.com/oembed",
    ),
    (
        "ytmusic",
        "YouTube Music",
        "adapter",
        "Unofficial unauthenticated discovery; may change",
        "https://ytmusicapi.readthedocs.io/",
    ),
    (
        "spotify",
        "Spotify",
        "limited",
        "Public oEmbed title lookup; not a catalog/chart API",
        "https://developer.spotify.com/documentation/embeds/reference/oembed",
    ),
    (
        "deezer",
        "Deezer",
        "adapter",
        "Public chart and artist/album/track metadata",
        "https://developers.deezer.com/api",
    ),
    (
        "archive",
        "Internet Archive",
        "adapter",
        "Live Music Archive item metadata, not individual tracks",
        "https://archive.org/developers/",
    ),
    (
        "wikidata",
        "Wikidata",
        "adapter",
        "Explicit Q-ID lookup and identifier crosswalks, no name merging",
        "https://www.wikidata.org/wiki/Wikidata:Data_access",
    ),
    (
        "soundcloud",
        "SoundCloud",
        "limited",
        "Public user/track oEmbed only, no client-ID extraction",
        "https://developers.soundcloud.com/docs/oembed",
    ),
    (
        "openverse",
        "Openverse",
        "adapter",
        "Music-only metadata; retains license and attribution",
        "https://api.openverse.org/v1/",
    ),
    (
        "amazon",
        "Amazon Music",
        "credentials",
        "Documented API requires approved OAuth and x-api-key; links only",
        "https://developer.amazon.com/docs/music/API_web_overview.html",
    ),
    (
        "discogs",
        "Discogs",
        "adapter",
        "Keyless artist/master/release lookups and local CC0 XML dump import",
        "https://data.discogs.com/",
    ),
    (
        "openwhyd",
        "Openwhyd",
        "adapter",
        "Public hot-track discovery via explicit YouTube/SoundCloud IDs; no user profiles",
        "https://github.com/openwhyd/openwhyd/blob/main/docs/API.md",
    ),
    (
        "acousticbrainz",
        "AcousticBrainz",
        "bulk",
        "Historical acoustic-feature data; collection discontinued",
        "https://acousticbrainz.org/",
    ),
    (
        "fma",
        "Free Music Archive dataset",
        "bulk",
        "Metadata archive; check dataset licenses; no audio imported",
        "https://github.com/mdeff/fma",
    ),
    (
        "mtg-jamendo",
        "MTG-Jamendo dataset",
        "bulk",
        "Research annotations; dataset-specific license, not a catalog API",
        "https://github.com/MTG/mtg-jamendo-dataset",
    ),
    (
        "msd",
        "Million Song Dataset",
        "bulk",
        "Historical metadata/features; not current popularity",
        "https://millionsongdataset.com/",
    ),
    (
        "dbpedia",
        "DBpedia",
        "candidate",
        "Linked open data; needs a music-specific mapping and license audit",
        "https://www.dbpedia.org/resources/",
    ),
    (
        "radio-browser",
        "Radio Browser",
        "out-of-scope",
        "No-key station directory, not artist/album/song identities",
        "https://api.radio-browser.info/",
    ),
    (
        "lastfm",
        "Last.fm",
        "credentials",
        "Music API requires a registered API key",
        "https://www.last.fm/api/intro",
    ),
    (
        "jamendo",
        "Jamendo",
        "credentials",
        "Public API requires client_id; Openverse exposes some licensed metadata",
        "https://developer.jamendo.com/v3.0",
    ),
    (
        "setlistfm",
        "setlist.fm",
        "credentials",
        "Concert/setlist API requires x-api-key",
        "https://api.setlist.fm/docs/1.0/index.html",
    ),
    (
        "bandcamp",
        "Bandcamp",
        "credentials",
        "Partner API requires OAuth; no HTML crawler enabled",
        "https://bandcamp.com/developer",
    ),
    (
        "coverartarchive",
        "Cover Art Archive",
        "out-of-scope",
        "Artwork metadata, not another catalog; no image downloads",
        "https://musicbrainz.org/doc/Cover_Art_Archive/API",
    ),
)


def task_source(task: str) -> str:
    prefix = task.split("-", 1)[0]
    return {
        "mb": "musicbrainz",
        "lb": "listenbrainz",
        "yt": "youtube",
        "ytm": "ytmusic",
    }.get(prefix, prefix if prefix in PUBLIC_SOURCES else "apple")


def lookup_task(source: str, kind: str) -> str:
    if source in PUBLIC_SOURCES:
        if kind not in KINDS[source]:
            raise ValueError(f"{source} does not support {kind} seeds")
        return f"{source}-lookup"
    if source == "youtube":
        if kind not in ("artist", "song"):
            raise ValueError("YouTube supports channel and video seeds only")
        return "yt-feed" if kind == "artist" else "yt-video"
    if source == "ytmusic":
        return f"ytm-{kind}"
    return "mb-lookup" if source == "musicbrainz" else "lookup"


def canonical_url(source: str, kind: str, identifier: str) -> str:
    if source == "omdb":
        return "https://github.com/OatsCG/OMDB"
    path = "track" if kind == "song" else kind
    if source == "ytmusic" and kind == "artist":
        return f"https://music.youtube.com/channel/{identifier}"
    if source == "spotify":
        return f"https://open.spotify.com/{path}/{identifier}"
    if source == "deezer":
        return f"https://www.deezer.com/{path}/{identifier}"
    if source == "archive":
        return f"https://archive.org/details/{identifier}"
    if source == "wikidata":
        return f"https://www.wikidata.org/wiki/{identifier}"
    if source == "soundcloud":
        return f"https://soundcloud.com/{identifier.replace('~', '/')}"
    if source == "openverse":
        return f"https://openverse.org/audio/{identifier}"
    if source == "discogs":
        if kind == "artist":
            return f"https://www.discogs.com/artist/{identifier}"
        return f"https://www.discogs.com/{'master' if identifier.startswith('m') else 'release'}/{identifier[1:]}"
    raise ValueError("No canonical URL for this source")


def external_identity(url: str):
    """Accept only explicit canonical provider links, never arbitrary fetch targets."""
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (443, None)
    ):
        return None
    parts = parsed.path.strip("/").split("/")
    host = parsed.hostname
    if host in ("discogs.com", "www.discogs.com") and len(parts) == 2:
        identifier = parts[1].split("-", 1)[0]
        if re.fullmatch("[1-9][0-9]{0,19}", identifier):
            if parts[0] == "artist":
                return ("discogs", "artist", identifier)
            if parts[0] in ("master", "release"):
                return ("discogs", "album", ("m" if parts[0] == "master" else "r") + identifier)
    if host in ("youtube.com", "www.youtube.com", "music.youtube.com"):
        if len(parts) == 2 and parts[0] == "channel":
            from catalog.model import entity_key

            try:
                entity_key("global", "artist", parts[1], "ytmusic")
            except ValueError:
                return None
            return ("ytmusic", "artist", parts[1])
    if host in ("open.spotify.com", "www.deezer.com", "deezer.com"):
        if len(parts) == 3 and parts[0].startswith("intl-"):
            parts = parts[1:]
        if len(parts) == 2 and parts[0] in ("artist", "album", "track"):
            return (
                "spotify" if host == "open.spotify.com" else "deezer",
                "song" if parts[0] == "track" else parts[0],
                parts[1],
            )
    if host in ("music.amazon.com", "www.amazon.com", "amazon.com"):
        if len(parts) >= 2 and parts[-2] in ("artists", "albums", "tracks", "dp"):
            return (
                "amazon",
                "song"
                if parts[-2] == "tracks"
                else (
                    "artist" if parts[-2] == "artists" else None if parts[-2] == "dp" else "album"
                ),
                parts[-1],
            )
    if host == "www.wikidata.org" and len(parts) == 2 and parts[0] == "wiki":
        return ("wikidata", None, parts[1])
    if host in ("musicbrainz.org", "www.musicbrainz.org") and len(parts) == 2:
        kind = {"artist": "artist", "release-group": "album", "recording": "song"}.get(parts[0])
        if kind:
            return ("musicbrainz", kind, parts[1])
    return None
