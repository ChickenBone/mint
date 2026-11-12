# Source coverage and research

This service has **14 implemented network adapters** plus an **OMDB bulk reader**,
including two deliberately limited oEmbed adapters. The **27 distinct sources/datasets**
below were researched; research is not a claim that all 27 have working crawlers. Availability, terms
and limits can change. No upstream accounts, keys, browser tokens, media
downloads or access-control workarounds are used.

## Implemented

| Source / reference | Actual no-key coverage | Discovery / popularity |
| --- | --- | --- |
| [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) / [JSON dumps](https://musicbrainz.org/doc/Development/JSON_Data_Dumps) | Artist, release-group and recording metadata and public genres; paginated artist discographies; up to three releases per group with bounded recording pages; explicit provider links; streaming official JSON/tar.xz imports, including recordings nested in releases | Bulk population without per-ID API calls. Core metadata is CC0; dump genres are CC BY-NC-SA 3.0 and explicitly annotated. |
| [ListenBrainz](https://listenbrainz.readthedocs.io/en/latest/users/api/statistics.html) | Sitewide weekly recording statistics with explicit MusicBrainz IDs | Community-scoped ranking, not worldwide play counts |
| [Apple Music / iTunes](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) | Opt-in public storefront chart feeds and bounded lookups; not the credentialed Apple Music API | Storefront chart ranks |
| [YouTube](https://www.youtube.com/oembed) | Public video oEmbed and channel Atom feeds; recent uploads, not entire channel histories | Available public feed view observations |
| [YouTube Music](https://ytmusicapi.readthedocs.io/) | Unofficial unauthenticated charts, artists, albums and songs | Explicit chart ranks only; playlist order is not a rank |
| [Spotify](https://developer.spotify.com/documentation/embeds/reference/oembed) | Public artist/album/track **title lookup only**; seeded IDs or explicit metadata crosswalks | No charts, popularity, discography enumeration or Web API emulation |
| [Deezer](https://developers.deezer.com/api) | Public chart, artist, album and track metadata; bounded artist-album and album-track pagination | Explicit `position`, never the unrelated `rank` score |
| [Audius](https://docs.audius.co/api/) | Public trending, user and track metadata; bounded user-track pagination | Raw track play-count observations; list order is not a chart rank |
| [Internet Archive](https://archive.org/developers/) | Live Music Archive top-download item search and metadata; live sets represented as albums | Raw item-download observations, not individual song plays |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Data_access) | Explicit Q-ID lookup, English-preferred labels with recorded fallback language and selected asserted provider identifiers | No inferred matches, global popularity or general Wikidata crawl |
| [SoundCloud](https://developers.soundcloud.com/docs/oembed) | Public user/track oEmbed metadata from explicit slugs | No search/chart crawl, account API or extracted client IDs |
| [Openverse](https://api.openverse.org/v1/) | Music-classified audio metadata only; license, attribution and landing-page link retained | Bounded discovery feed, not ranked popularity |
| [Discogs](https://data.discogs.com/) / [public client reference](https://github.com/joalla/discogs_client) | Unauthenticated artist/master/release lookups and paginated artist releases; local CC0 artist/master/release XML or XML.gz import | Explicit genres and credits; styles separately attributed. Release `have`/`want` counts are scoped collection/wishlist observations, not plays. No authenticated database search or fabricated track IDs. |
| [Openwhyd public export](https://github.com/openwhyd/openwhyd/blob/main/docs/API.md) | Public `/hot?format=json` feed; explicit YouTube video and SoundCloud slug identities only | Source posts/reposts/likes when supplied. No invented rank, user profiles, comments or stream URLs. Unsupported platforms are counted in logs. |
| [Openmusic Database (OMDB)](https://github.com/OatsCG/OMDB) | Local PostgreSQL tar/custom-dump metadata reader; independent `omdb` IDs, album membership and explicit artist/featured-artist credits | Published subscriber/view observations remain OMDB-scoped. No network crawler, playback tables, media, artwork or inferred genres. Publisher describes research-purpose data; its software MIT license does not establish a license for all dataset contents. |

`PUBLIC_SOURCES=spotify,deezer,audius,archive,wikidata,soundcloud,openverse,discogs,openwhyd`
enables the nine additional adapters. The other five have their own enable
flags. Existing `.env` files are not changed automatically.

Deezer, Audius, Archive, Openverse and Openwhyd start from public discovery feeds. Spotify,
SoundCloud and Wikidata require explicit seeds or supported external identifiers
found in MusicBrainz/Wikidata metadata. For SoundCloud song IDs use
`user~track` (the two URL slugs); artist IDs use the user slug.

Discogs artist IDs are numeric; albums use `m504` for master 504 and `r504` for
release 504. Masters and individual editions never collapse into one identity.
Explicit MusicBrainz URLs can seed Discogs; otherwise add an artist ID manually.
Artist releases use 100-record pages with an explicit 100,000-offset cap.
No list position/year becomes a popularity rank. Artist bios, submitters,
contributors, images, videos and tracklists are not persisted.

Bounded live probes verified Discogs artist/master/release/discography endpoints
without credentials. Actual rate headers advertised **25 requests/minute** for
unauthenticated access; the shared minimum is 2.5 seconds, not the authenticated
60/minute limit sometimes quoted online. The official developer page returned
403 during research and was not bypassed. The official dump index independently
documents monthly XML and CC0 licensing.

Openwhyd's public documentation explicitly permits unauthenticated exports and
asks for reasonable delays; the adapter retains a minimum two-second interval.
The live hot endpoint returns an object containing `tracks`, while the general
export documentation shows an array; both shapes are supported. Only the current
20-result hot window is requested; the upstream controller explicitly caps the
window at 20 and does not support pagination. No exhaustive historical crawl, category-to-genre
inference or authenticated User API is implemented.

OMDB's published OneDrive links advertise May 2026 expiry; normal public
download probes found the lite link expired and the full link removed. The bulk reader was
verified using a generated PostgreSQL tar archive matching the documented schema,
not the unavailable full dataset. No claimed automatic download or completed
OMDB population follows from that compatibility check.

MusicBrainz's `recording.tar.xz` contains only standalone recordings.
Import `release.tar.xz` as well for the recordings attached to releases; record
IDs come from embedded recording objects, never track positions or release IDs.
Multiple release-group memberships are retained as explicit graph edges.
The loader downloads immutable official snapshots and verifies their published
checksums over HTTPS; this is integrity checking, not independent PGP verification.

Crosswalks preserve separate records and their provenance. An asserted link is
not proof that two providers have equivalent editions or recordings. Amazon
ASINs are retained as product links, not assumed to be Amazon Music albums.

## Researched, not implemented as crawlers

| Source / reference | Access finding / reason |
| --- | --- |
| [Amazon Music](https://developer.amazon.com/docs/music/API_web_overview.html) | Documented API requires approved access, OAuth and `x-api-key`. **Links only** from explicit open metadata; no working no-key Amazon catalog adapter is claimed. |
| [AcousticBrainz](https://acousticbrainz.org/) | Historical acoustic features; collection discontinued in 2022. Not current popularity. |
| [Free Music Archive dataset](https://github.com/mdeff/fma) | Published metadata/features with dataset and track-specific licensing. No dataset or audio imported. |
| [MTG-Jamendo dataset](https://github.com/MTG/mtg-jamendo-dataset) | Research tags/annotations with dataset-specific licensing. Not the live Jamendo API. |
| [Million Song Dataset](http://millionsongdataset.com/) | Historical metadata/features, not live catalog popularity. Primary site could not be retrieved during verification; no current endpoint availability claim. |
| [DBpedia](https://www.dbpedia.org/resources/) | Linked open data; needs a music-specific mapping and license audit. Not enabled. |
| [Radio Browser](https://api.radio-browser.info/) | Free/open station directory. Stations do not fit current artist/album/song identities. |
| [Last.fm](https://www.last.fm/api/intro) | Documented music API requires a registered key. Not enabled. |
| [Jamendo](https://developer.jamendo.com/v3.0) | Documented API requires `client_id`. Some licensed metadata is independently available through Openverse. |
| [setlist.fm](https://api.setlist.fm/docs/1.0/index.html) | Concert/setlist API requires `x-api-key`. Not enabled. |
| [Bandcamp](https://bandcamp.com/developer) | Partner API requires OAuth. No general public catalog API verified; no HTML crawler enabled. |
| [Cover Art Archive](https://musicbrainz.org/doc/Cover_Art_Archive/API) | Artwork metadata, not another music catalog. Documentation returned a browser challenge during research; no bypass or image downloads. |

Public endpoint availability is not unrestricted redistribution permission.
Review upstream terms for the intended use and retain required attribution.
Credential-required providers are not silently replaced or presented as active.
