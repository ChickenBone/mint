import base64
import json
from urllib.parse import quote, unquote

from fastapi import HTTPException

from catalog.graph import MAX_EDGES, MAX_NODES


FIELDS = """e.key,e.title,e.artist,e.source,e.kind,e.popularity,e.revision,
            e.indexed_revision,e.genres,e.url,c.canonical_id"""
FROM = """FROM entities e LEFT JOIN canonical_artists c ON c.identity=e.artist_identity"""
KINDS = ("artist", "album", "song")
RECORD_LIMIT = 150
NEIGHBOR_LIMIT = 60


def genre_name(value):
    return " ".join(value.split()).lower()


def genre_key(value):
    return "genre:" + quote(genre_name(value), safe="")


def root_cursor(value):
    if not value:
        return dict.fromkeys(KINDS, "")
    try:
        parsed = json.loads(base64.urlsafe_b64decode(value.encode("ascii")))
        if not isinstance(parsed, dict) or set(parsed) != set(KINDS):
            raise ValueError("Invalid cursor fields")
        if any(
            item is not None and (not isinstance(item, str) or len(item) > 160)
            for item in parsed.values()
        ):
            raise ValueError("Invalid cursor values")
        return parsed
    except (ValueError, UnicodeError) as error:
        raise HTTPException(400, "Invalid catalog page cursor; return to Overview") from error


def catalog_network(conn, *, key=None, query="", after="", limit=10):
    """Return a bounded mixed-kind graph of stored relationships and explicit genre tags."""
    conn.execute("SET LOCAL statement_timeout='2000ms'")
    next_page = None
    genre = None
    root = None
    if key and key.startswith("genre:"):
        genre = genre_name(unquote(key[6:]))
        if not genre or len(genre) > 100 or genre_key(genre) != key:
            raise HTTPException(400, "Invalid genre key")
        roots = conn.execute(
            f"""SELECT {FIELDS} {FROM} WHERE e.key>%s
                AND (numnode(plainto_tsquery('simple',%s))=0
                     OR e.search@@plainto_tsquery('simple',%s))
                AND EXISTS (SELECT 1 FROM unnest(e.genres) tag
                    WHERE lower(btrim(regexp_replace(tag,'\\s+',' ','g')))=%s)
                ORDER BY e.key LIMIT %s""",
            (after, genre, genre, genre, NEIGHBOR_LIMIT + 1),
        ).fetchall()
        if not roots and not after:
            raise HTTPException(404, "No stored records carry this genre tag")
        if len(roots) > NEIGHBOR_LIMIT:
            next_page = roots[NEIGHBOR_LIMIT - 1]["key"]
        roots = roots[:NEIGHBOR_LIMIT]
    elif key:
        root = conn.execute(f"SELECT {FIELDS} {FROM} WHERE e.key=%s", (key,)).fetchone()
        if root is None:
            raise HTTPException(404, "Stored catalog record not found")
        roots = [root]
    else:
        cursor = root_cursor(after)
        roots = []
        for kind in KINDS:
            if cursor[kind] is None:
                continue
            page = conn.execute(
                f"""SELECT {FIELDS} {FROM} WHERE e.kind=%s AND e.key>%s
                    AND (%s='' OR e.search@@plainto_tsquery('simple',%s))
                    ORDER BY e.key LIMIT %s""",
                (kind, cursor[kind], query, query, limit + 1),
            ).fetchall()
            cursor[kind] = page[limit - 1]["key"] if len(page) > limit else None
            roots.extend(page[:limit])
        if any(value is not None for value in cursor.values()):
            next_page = base64.urlsafe_b64encode(
                json.dumps(cursor, separators=(",", ":")).encode()
            ).decode()
    rows = {row["key"]: row for row in roots}
    aliases = list(rows)
    if root and root["canonical_id"]:
        aliases = [
            row["key"]
            for row in conn.execute(
                """SELECT e.key FROM entities e JOIN canonical_artists c
                   ON c.identity=e.artist_identity WHERE c.canonical_id=%s""",
                (root["canonical_id"],),
            ).fetchall()
        ]
    neighbors = conn.execute(
        f"""SELECT {FIELDS} {FROM} WHERE e.key IN (
            SELECT target FROM edges WHERE source=ANY(%s)
            UNION SELECT source FROM edges WHERE target=ANY(%s))
            AND NOT (e.key=ANY(%s)) AND e.key>%s ORDER BY e.key LIMIT %s""",
        (aliases, aliases, list(rows), after if root else "", NEIGHBOR_LIMIT + 1),
    ).fetchall()
    neighbors_limited = len(neighbors) > NEIGHBOR_LIMIT
    if root and neighbors_limited:
        next_page = neighbors[NEIGHBOR_LIMIT - 1]["key"]
    rows.update((row["key"], row) for row in neighbors[:NEIGHBOR_LIMIT])
    remaining = RECORD_LIMIT - len(rows)
    outgoing = conn.execute(
        f"""SELECT {FIELDS} {FROM} WHERE e.key IN (
            SELECT target FROM edges WHERE source=ANY(%s))
            AND NOT (e.key=ANY(%s)) ORDER BY e.key LIMIT %s""",
        (list(rows), list(rows), remaining + 1),
    ).fetchall()
    outgoing_limited = len(outgoing) > remaining
    rows.update((row["key"], row) for row in outgoing[:remaining])
    nodes, identities, mapped = {}, {}, {}
    for row in sorted(rows.values(), key=lambda row: row["key"]):
        identity = row["canonical_id"] or row["key"]
        representative = identities.setdefault(identity, row["key"])
        mapped[row["key"]] = representative
        if representative not in nodes:
            nodes[representative] = {**row, "sources": []}
        if row["source"] not in nodes[representative]["sources"]:
            nodes[representative]["sources"].append(row["source"])
    stored = conn.execute(
        """SELECT source,target,relation FROM edges
           WHERE source=ANY(%s) AND target=ANY(%s)
           ORDER BY source,target LIMIT %s""",
        (list(rows), list(rows), MAX_EDGES + 1),
    ).fetchall()
    relationships = {}

    def connect(source, target, relation, evidence):
        if source == target:
            return
        edge = relationships.setdefault(
            (source, target, relation),
            {"source": source, "target": target, "relation": relation, "evidence": {}},
        )
        edge["evidence"][evidence["key"]] = {
            field: evidence[field] for field in ("key", "title", "kind", "url")
        }

    for edge in stored[:MAX_EDGES]:
        connect(
            mapped[edge["source"]], mapped[edge["target"]], edge["relation"], rows[edge["source"]]
        )
    genres_limited = False
    if genre:
        nodes[genre_key(genre)] = {
            "key": genre_key(genre),
            "title": genre,
            "kind": "genre",
            "source": "catalog",
            "sources": [],
            "popularity": 0,
            "derived": True,
        }
    for row in rows.values():
        for tag in sorted(row["genres"], key=lambda tag: genre_name(tag) != genre):
            name = genre_name(tag)
            if not name:
                continue
            tag_key = genre_key(name)
            if tag_key not in nodes:
                if len(nodes) >= MAX_NODES:
                    genres_limited = True
                    continue
                nodes[tag_key] = {
                    "key": tag_key,
                    "title": name,
                    "kind": "genre",
                    "source": "catalog",
                    "sources": [],
                    "popularity": 0,
                    "derived": True,
                }
            connect(mapped[row["key"]], tag_key, "genre", row)
    edges = []
    for relationship in relationships.values():
        evidence = list(relationship["evidence"].values())
        edges.append(
            {
                **relationship,
                "evidence": evidence[:5],
                "evidence_count": len(evidence),
                "evidence_truncated": len(evidence) > 5,
            }
        )
    capped = len(stored) > MAX_EDGES or len(edges) > MAX_EDGES or genres_limited
    return {
        "scope": "catalog",
        "focus": genre_key(genre) if genre else mapped.get(key),
        "nodes": list(nodes.values()),
        "edges": edges[:MAX_EDGES],
        "next": next_page,
        "truncated": bool(next_page or neighbors_limited or outgoing_limited or capped),
        "limits": {
            "neighbors": neighbors_limited,
            "outgoing": outgoing_limited,
            "genres": genres_limited,
            "view_capacity": capped,
        },
        "notice": (
            "Artists, songs and albums connect through stored credits and album membership. "
            "Genre hubs come only from explicit source tags, not inferred similarity. "
            "This is an expandable catalog slice, not the entire database."
        ),
    }
