from fastapi import HTTPException


NODE_FIELDS = "e.key,e.title,e.artist,e.source,e.kind,e.popularity,e.revision,e.indexed_revision"
MAX_NODES = 180
MAX_EDGES = 400


def artist_nodes(conn, identities):
    rows = conn.execute(
        f"""SELECT {NODE_FIELDS},c.canonical_id FROM canonical_artists c
            JOIN entities e ON e.artist_identity=c.identity
            WHERE c.canonical_id=ANY(%s) ORDER BY c.canonical_id,e.key""",
        (identities,),
    ).fetchall()
    nodes = {}
    for row in rows:
        group = row["canonical_id"]
        if group not in nodes:
            nodes[group] = {**row, "sources": []}
        if row["source"] not in nodes[group]["sources"]:
            nodes[group]["sources"].append(row["source"])
    return nodes


def artist_network(conn, *, key=None, query="", after="", limit=12):
    """Project shared stored credits onto canonical artists; never infer name similarity."""
    conn.execute("SET LOCAL statement_timeout='2000ms'")
    if key:
        root = conn.execute(
            """SELECT c.canonical_id FROM entities e JOIN canonical_artists c
               ON c.identity=e.artist_identity WHERE e.key=%s""",
            (key,),
        ).fetchone()
        if root is None:
            raise HTTPException(404, "Stored artist not found")
        roots = [root]
        next_artists = None
    else:
        roots = conn.execute(
            """SELECT c.canonical_id FROM entities e JOIN canonical_artists c
               ON c.identity=e.artist_identity
               WHERE e.kind='artist' AND c.canonical_id>%s
               AND (%s='' OR e.search@@plainto_tsquery('simple',%s))
               GROUP BY c.canonical_id ORDER BY c.canonical_id LIMIT %s""",
            (after, query, query, limit + 1),
        ).fetchall()
        next_artists = roots[limit - 1]["canonical_id"] if len(roots) > limit else None
        roots = roots[:limit]
    root_ids = [row["canonical_id"] for row in roots]
    nodes = artist_nodes(conn, root_ids)
    shared = {}
    next_credits = None
    overview_limited = False
    peers_limited = False
    # Each root and each record has an independent SQL bound, even for prolific artists.
    for identity in root_ids:
        aliases = conn.execute(
            """SELECT e.key FROM canonical_artists c JOIN entities e
               ON e.artist_identity=c.identity WHERE c.canonical_id=%s""",
            (identity,),
        ).fetchall()
        credit_limit = 50 if key else 10
        records = conn.execute(
            """SELECT DISTINCT r.key,r.title,r.kind,r.url FROM edges a
               JOIN entities r ON r.key=a.source
               WHERE a.target=ANY(%s) AND a.relation='artist'
               AND r.kind IN ('song','album') AND r.key>%s
               ORDER BY r.key LIMIT %s""",
            ([row["key"] for row in aliases], after if key else "", credit_limit + 1),
        ).fetchall()
        if len(records) > credit_limit:
            if key:
                next_credits = records[credit_limit - 1]["key"]
            else:
                overview_limited = True
        records = records[:credit_limit]
        peers = conn.execute(
            """SELECT r.key,p.canonical_id FROM unnest(%s::text[]) r(key)
               CROSS JOIN LATERAL (
                 SELECT DISTINCT c.canonical_id FROM edges a
                 JOIN entities e ON e.key=a.target
                 JOIN canonical_artists c ON c.identity=e.artist_identity
                 WHERE a.source=r.key AND a.relation='artist' AND c.canonical_id<>%s
                 ORDER BY c.canonical_id LIMIT 21
               ) p ORDER BY r.key,p.canonical_id""",
            ([row["key"] for row in records], identity),
        ).fetchall()
        counts = {}
        evidence = {row["key"]: row for row in records}
        for peer in peers:
            counts[peer["key"]] = counts.get(peer["key"], 0) + 1
            if counts[peer["key"]] > 20:
                peers_limited = True
                continue
            pair = tuple(sorted((identity, peer["canonical_id"])))
            shared.setdefault(pair, {})[peer["key"]] = evidence[peer["key"]]
    wanted = sorted({identity for pair in shared for identity in pair} - set(nodes))
    nodes.update(artist_nodes(conn, wanted[: MAX_NODES - len(nodes)]))
    edges = []
    for (left, right), evidence in sorted(shared.items()):
        if left not in nodes or right not in nodes:
            continue
        edges.append(
            {
                "source": nodes[left]["key"],
                "target": nodes[right]["key"],
                "relation": "shared_credit",
                "evidence": list(evidence.values())[:5],
                "evidence_count": len(evidence),
                "evidence_truncated": len(evidence) > 5,
            }
        )
    capped = len(wanted) > MAX_NODES - len(root_ids) or len(edges) > MAX_EDGES
    return {
        "scope": "artists",
        "focus": nodes[root_ids[0]]["key"] if key else None,
        "nodes": list(nodes.values()),
        "edges": edges[:MAX_EDGES],
        "next": next_credits if key else next_artists,
        "truncated": bool(
            next_artists or next_credits or overview_limited or peers_limited or capped
        ),
        "limits": {
            "overview_credits": overview_limited,
            "record_artists": peers_limited,
            "view_capacity": capped,
        },
        "notice": (
            "Links show shared song/album credits, not similarity. "
            "Verified provider identities share one artist node."
        ),
    }
