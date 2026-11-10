import time


def storage(store):
    with store.transaction() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SET LOCAL statement_timeout='2000ms'")
        database = conn.execute("SELECT pg_database_size(current_database()) AS bytes").fetchone()[
            "bytes"
        ]
        rows = conn.execute(
            """SELECT c.relname AS name,pg_table_size(c.oid) AS table_bytes,
               pg_indexes_size(c.oid) AS index_bytes,
               pg_total_relation_size(c.oid) AS total_bytes
               FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname"""
        ).fetchall()
    return {
        "at": time.time(),
        "postgres": {
            "database_bytes": database,
            "table_bytes": sum(row["table_bytes"] for row in rows),
            "index_bytes": sum(row["index_bytes"] for row in rows),
            "queue_bytes": sum(
                row["total_bytes"] for row in rows if row["name"] in ("jobs", "vector_outbox")
            ),
            "tables": rows,
        },
        "qdrant": {
            "disk_bytes": None,
            "note": "Qdrant's collection API does not report disk usage; not included in PostgreSQL size.",
        },
        "notice": "Measured PostgreSQL database size includes system catalogs and indexes. "
        "Table/index breakdown covers public catalog tables only, not WAL, backups, free disk or other containers.",
    }
