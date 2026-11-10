import re
import time

from fastapi import HTTPException

from catalog.catalog_network import genre_key
from catalog.providers import SOURCES, RESEARCH


LEAF_SIZE = 80
TAG_SQL = """SELECT DISTINCT e.key,
             lower(btrim(regexp_replace(tag,'\\s+',' ','g'))) AS tag
             FROM entities e CROSS JOIN LATERAL unnest(e.genres) tag
             WHERE btrim(regexp_replace(tag,'\\s+',' ','g'))<>''"""
GROUP_SQL = """SELECT source,kind,count(*) AS records FROM entities
               GROUP BY source,kind ORDER BY source,kind"""
TITLES = {"artist": "Artists", "album": "Albums", "song": "Songs", "genre": "Genre tags"}
SOURCE_NAMES = {row[0]: row[1] for row in RESEARCH}


def group_key(source, kind, prefix=""):
    return f"atlas:{source}:{kind}:{prefix}"


def group_node(source, kind, count, prefix="", *, context=False):
    return {
        "key": group_key(source, kind, prefix),
        "title": f"{SOURCE_NAMES[source]} · {TITLES[kind]}"
        if source != "catalog"
        else TITLES[kind],
        "kind": kind,
        "source": source,
        "count": count,
        "group": {"source": source, "kind": kind, "prefix": prefix},
        "context": context,
        "popularity": 0,
    }


def atlas(conn, source=None, kind=None, prefix=""):
    """Cover every stored record with disjoint groups, refining only a requested branch."""
    conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    conn.execute("SET LOCAL statement_timeout='10000ms'")
    if source is None:
        if kind is not None or prefix:
            raise HTTPException(422, "Choose a source and type before expanding a group")
        return overview(conn)
    if not (
        (source in SOURCES and source != "listenbrainz" and kind in ("artist", "album", "song"))
        or (source == "catalog" and kind == "genre")
    ) or not re.fullmatch("[0-9a-f]{0,32}", prefix):
        raise HTTPException(422, "Invalid catalog group")
    if kind == "genre":
        scope_sql = f"WITH tags AS ({TAG_SQL}) SELECT DISTINCT tag FROM tags"
        rows = conn.execute(
            f"""WITH scoped AS ({scope_sql})
                SELECT count(*) AS records FROM scoped WHERE starts_with(md5(tag),%s)""",
            (prefix,),
        ).fetchone()
    else:
        rows = conn.execute(
            """SELECT count(*) AS records FROM entities
               WHERE source=%s AND kind=%s AND starts_with(md5(key),%s)""",
            (source, kind, prefix),
        ).fetchone()
    count = rows["records"]
    if count > LEAF_SIZE:
        if kind == "genre":
            buckets = conn.execute(
                f"""WITH scoped AS ({scope_sql})
                    SELECT left(md5(tag),%s) AS prefix,count(*) AS records FROM scoped
                    WHERE starts_with(md5(tag),%s) GROUP BY 1 ORDER BY 1""",
                (len(prefix) + 1, prefix),
            ).fetchall()
        else:
            buckets = conn.execute(
                """SELECT left(md5(key),%s) AS prefix,count(*) AS records FROM entities
                   WHERE source=%s AND kind=%s AND starts_with(md5(key),%s)
                   GROUP BY 1 ORDER BY 1""",
                (len(prefix) + 1, source, kind, prefix),
            ).fetchall()
        if len(prefix) == 32:
            raise HTTPException(409, "Catalog key partition cannot be refined; use catalog search")
        nodes = [
            {
                **group_node(source, kind, row["records"], row["prefix"]),
                "title": f"{TITLES[kind]} · group {index + 1}",
            }
            for index, row in enumerate(buckets)
        ]
        return result(nodes, [], count, source, kind, prefix)
    if kind == "genre":
        tags = conn.execute(
            f"""WITH tags AS ({TAG_SQL})
                SELECT tag,count(*) AS records FROM tags
                WHERE starts_with(md5(tag),%s) GROUP BY tag ORDER BY tag LIMIT %s""",
            (prefix, LEAF_SIZE),
        ).fetchall()
        nodes = [
            {
                "key": genre_key(row["tag"]),
                "title": row["tag"],
                "kind": "genre",
                "source": "catalog",
                "count": row["records"],
                "popularity": 0,
                "derived": True,
            }
            for row in tags
        ]
        return result(nodes, [], count, source, kind, prefix)
    nodes = conn.execute(
        """SELECT key,title,artist,source,kind,popularity,revision,indexed_revision,url
           FROM entities WHERE source=%s AND kind=%s AND starts_with(md5(key),%s)
           ORDER BY key LIMIT %s""",
        (source, kind, prefix, LEAF_SIZE),
    ).fetchall()
    keys = [row["key"] for row in nodes]
    relationships = conn.execute(
        """WITH incident AS (
           SELECT source,target,relation FROM edges WHERE source=ANY(%s)
           UNION SELECT source,target,relation FROM edges WHERE target=ANY(%s))
           SELECT CASE WHEN s.key=ANY(%s) THEN s.key ELSE 'atlas:'||s.source||':'||s.kind||':' END AS source,
                  CASE WHEN t.key=ANY(%s) THEN t.key ELSE 'atlas:'||t.source||':'||t.kind||':' END AS target,
                  d.relation,count(*) AS count
           FROM incident d JOIN entities s ON s.key=d.source JOIN entities t ON t.key=d.target
           GROUP BY 1,2,3 ORDER BY 1,2,3""",
        (keys, keys, keys, keys),
    ).fetchall()
    context_keys = {
        edge[endpoint]
        for edge in relationships
        for endpoint in ("source", "target")
        if edge[endpoint].startswith("atlas:")
    }
    if context_keys:
        for row in conn.execute(GROUP_SQL).fetchall():
            if group_key(row["source"], row["kind"]) in context_keys:
                nodes.append(group_node(row["source"], row["kind"], row["records"], context=True))
    return result(nodes, relationships, count, source, kind, prefix)


def overview(conn):
    rows = conn.execute(GROUP_SQL).fetchall()
    nodes = [group_node(row["source"], row["kind"], row["records"]) for row in rows]
    total = sum(row["records"] for row in rows)
    edges = conn.execute(
        """SELECT 'atlas:'||s.source||':'||s.kind||':' AS source,
                  'atlas:'||t.source||':'||t.kind||':' AS target,d.relation,count(*) AS count
           FROM edges d JOIN entities s ON s.key=d.source JOIN entities t ON t.key=d.target
           GROUP BY 1,2,3 ORDER BY 1,2,3"""
    ).fetchall()
    tags = conn.execute(
        f"""WITH tags AS ({TAG_SQL})
            SELECT count(DISTINCT tag) AS genres,count(*) AS memberships FROM tags"""
    ).fetchone()
    if tags["genres"]:
        hub = group_node("catalog", "genre", tags["genres"])
        nodes.append(hub)
        memberships = conn.execute(
            f"""WITH tags AS ({TAG_SQL})
                SELECT e.source,e.kind,count(*) AS count FROM tags
                JOIN entities e ON e.key=tags.key GROUP BY e.source,e.kind ORDER BY 1,2"""
        ).fetchall()
        edges += [
            {
                "source": group_key(row["source"], row["kind"]),
                "target": hub["key"],
                "relation": "genre",
                "count": row["count"],
            }
            for row in memberships
        ]
    missing = conn.execute(
        """SELECT count(*) AS count FROM edges d
           WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.key=d.target)"""
    ).fetchone()["count"]
    return {
        **result(nodes, edges, total),
        "total_records": total,
        "genre_tags": tags["genres"],
        "tag_memberships": tags["memberships"],
        "unresolved_links": missing,
    }


def result(nodes, edges, count, source=None, kind=None, prefix=""):
    return {
        "scope": "atlas",
        "nodes": nodes,
        "edges": edges,
        "at": time.time(),
        "represented": count,
        "branch": {"source": source, "kind": kind, "prefix": prefix} if source else None,
        "unit": "genre tags" if kind == "genre" else "records",
        "notice": (
            "Every stored record is represented. Groups are storage partitions, not musical similarity. "
            "Zoom into or select a group to expand it; link counts aggregate stored relationships."
            if source is None
            else "All records in this branch are represented. Zoom into or select a group to expand. "
            "Other connected source groups provide context; they do not add to this branch's count."
        ),
    }
