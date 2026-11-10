import logging

from catalog.model import entity_key, provider_id


log = logging.getLogger(__name__)
AUTHORITIES = ("musicbrainz", "wikidata")


def artist_identity(source: str, identifier: str) -> str:
    # YouTube and YouTube Music use the same UC channel namespace, not name matching.
    entity_key("us" if source == "apple" else "global", "artist", identifier, source)
    return (
        f"{'ytmusic' if source == 'youtube' else source}:artist:{provider_id(identifier, source)}"
    )


def ensure_artist(conn, identity):
    conn.execute(
        """INSERT INTO canonical_artists(identity,canonical_id) VALUES (%s,%s)
           ON CONFLICT DO NOTHING""",
        (identity, identity),
    )


def link_artist(conn, key, source, kind, identifier):
    """Caller holds catalog_budget, serializing identity changes with ingestion."""
    row = conn.execute(
        "SELECT source,kind,artist_identity FROM entities WHERE key=%s", (key,)
    ).fetchone()
    if not row or row["kind"] != "artist" or kind != "artist" or source == "amazon":
        return
    status = conn.execute(
        """SELECT canonical_status FROM entity_links
           WHERE key=%s AND provider=%s AND kind=%s AND identifier=%s""",
        (key, source, kind, identifier),
    ).fetchone()
    if status["canonical_status"] == "excluded" or row["source"] not in AUTHORITIES:
        return
    left = row["artist_identity"]
    right = artist_identity(source, identifier)
    ensure_artist(conn, left)
    ensure_artist(conn, right)
    groups = conn.execute(
        """SELECT identity,canonical_id FROM canonical_artists WHERE canonical_id IN
           (SELECT canonical_id FROM canonical_artists WHERE identity=ANY(%s))
           ORDER BY identity""",
        ([left, right],),
    ).fetchall()
    providers = {}
    conflict = False
    for member in groups:
        provider = member["identity"].split(":", 1)[0]
        if provider in providers and providers[provider] != member["identity"]:
            conflict = True
        providers[provider] = member["identity"]
    if conflict:
        state = "conflict"
        log.warning(
            "artist_identity_conflict key=%s provider=%s identifier=%s", key, source, identifier
        )
    else:
        state = "accepted"
        conn.execute(
            """UPDATE canonical_artists SET canonical_id=%s WHERE canonical_id=ANY(%s)""",
            (
                min(member["identity"] for member in groups),
                list({m["canonical_id"] for m in groups}),
            ),
        )
    conn.execute(
        """UPDATE entity_links SET canonical_status=%s
           WHERE key=%s AND provider=%s AND kind=%s AND identifier=%s""",
        (state, key, source, kind, identifier),
    )


def rebuild_artists(conn):
    """Rebuild derived groups from retained evidence, preserving explicit exclusions."""
    conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
    conn.execute("DELETE FROM canonical_artists")
    conn.execute(
        """INSERT INTO canonical_artists(identity,canonical_id)
           SELECT DISTINCT artist_identity,artist_identity FROM entities
           WHERE artist_identity IS NOT NULL"""
    )
    conn.execute(
        "UPDATE entity_links SET canonical_status='unreviewed' WHERE canonical_status<>'excluded'"
    )
    # A server cursor bounds memory during an existing-catalog backfill.
    with conn.cursor(name="artist_identity_backfill") as cursor:
        cursor.execute(
            """SELECT l.key,l.provider,l.kind,l.identifier FROM entity_links l
               JOIN entities e ON e.key=l.key WHERE e.kind='artist' AND l.kind='artist'
               AND e.source=ANY(%s) AND l.canonical_status<>'excluded'
               ORDER BY l.key,l.provider,l.identifier""",
            (list(AUTHORITIES),),
        )
        for row in cursor:
            link_artist(conn, row["key"], row["provider"], row["kind"], row["identifier"])


def artist_groups(conn, keys):
    """Bounded provider attribution for groups touched by this candidate window."""
    rows = conn.execute(
        """WITH requested AS (
             SELECT e.key,c.canonical_id FROM entities e JOIN canonical_artists c
             ON c.identity=e.artist_identity WHERE e.key=ANY(%s))
           SELECT r.key AS requested_key,r.canonical_id,p.*
           FROM requested r CROSS JOIN LATERAL (
             SELECT e.key,e.source,e.country,e.provider_id,e.title,e.url
             FROM canonical_artists c JOIN entities e ON e.artist_identity=c.identity
             WHERE c.canonical_id=r.canonical_id ORDER BY e.key LIMIT 101
           ) p ORDER BY r.key,p.key""",
        (keys,),
    ).fetchall()
    groups = {}
    for row in rows:
        key = row.pop("requested_key")
        canonical_id = row.pop("canonical_id")
        group = groups.setdefault(key, {"canonical_id": canonical_id, "providers": []})
        group["providers"].append(row)
    for group in groups.values():
        group["providers_truncated"] = len(group["providers"]) > 100
        group["providers"] = group["providers"][:100]
    return groups
