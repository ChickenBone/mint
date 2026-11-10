import base64
import binascii
import json
import threading
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from psycopg import sql
from qdrant_client import models

from catalog.console import STATIC
from catalog.indexer import VECTOR_ERRORS
from catalog.model import DIMENSIONS


# Only the standalone service's tables, ordered by their complete primary keys.
TABLES = {
    "entities": (("key", "text"),),
    "edges": (("source", "text"), ("target", "text")),
    "chart_signals": (("chart", "text"), ("key", "text")),
    "jobs": (("key", "text"),),
    "vector_outbox": (("key", "text"),),
    "entity_links": (
        ("key", "text"),
        ("provider", "text"),
        ("kind", "text"),
        ("identifier", "text"),
    ),
    "entity_annotations": (("key", "text"),),
    "canonical_artists": (("identity", "text"),),
    "source_metrics": (("source", "text"),),
    "source_controls": (("source", "text"),),
    "host_budgets": (("host", "text"),),
    "activity": (("id", "bigint"),),
    "workers": (("id", "uuid"),),
    "catalog_schema": (("version", "integer"),),
    "catalog_budget": (("singleton", "boolean"),),
    "import_runs": (("id", "text"),),
}
Cursor = Annotated[str | None, Query(max_length=4096)]
Limit = Annotated[int, Query(ge=1, le=50)]
Exact = Annotated[str | None, Query(min_length=1, max_length=300)]


def encode_cursor(scope, values):
    return base64.urlsafe_b64encode(
        json.dumps({"scope": scope, "values": values}, separators=(",", ":")).encode()
    ).decode()


def decode_cursor(value, scope):
    try:
        body = json.loads(base64.b64decode(value, altchars=b"-_", validate=True))
        if not isinstance(body, dict) or body.get("scope") != scope:
            raise ValueError("Cursor belongs to a different dataset or filter")
        return body["values"]
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, binascii.Error) as error:
        raise HTTPException(422, "Invalid page cursor; return to the first page") from error


def typed(value, kind):
    try:
        if kind == "text" and isinstance(value, str) and len(value) <= 300:
            return value
        if kind == "uuid" and isinstance(value, str):
            return UUID(value)
        if kind == "boolean":
            if isinstance(value, bool):
                return value
            if value in ("true", "false"):
                return value == "true"
        if kind in ("integer", "bigint") and not isinstance(value, bool):
            if isinstance(value, int) or (
                isinstance(value, str) and value.isascii() and value.isdecimal()
            ):
                number = int(value)
                if 0 <= number < 2 ** (31 if kind == "integer" else 63):
                    return number
    except (ValueError, AttributeError) as error:
        raise HTTPException(422, "Invalid primary key value") from error
    raise HTTPException(422, "Invalid primary key value")


def router(app):
    capacity = threading.BoundedSemaphore(4)

    def admission():
        if not capacity.acquire(blocking=False):
            raise HTTPException(
                503, "Data browser is busy; retry shortly", headers={"Retry-After": "2"}
            )
        try:
            yield
        finally:
            capacity.release()

    routes = APIRouter(dependencies=[Depends(admission)])

    @routes.get("/data", include_in_schema=False)
    def page():
        return FileResponse(STATIC / "data.html", media_type="text/html")

    @routes.get("/v1/data/tables")
    def tables():
        with app.state.store.transaction() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            conn.execute("SET LOCAL statement_timeout='2000ms'")
            columns = conn.execute(
                """SELECT table_name,column_name,data_type,udt_name,is_nullable
                   FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=ANY(%s)
                   ORDER BY table_name,ordinal_position""",
                (list(TABLES),),
            ).fetchall()
        return {
            "tables": [
                {
                    "name": name,
                    "primary_key": [key for key, _ in keys],
                    "columns": [
                        {
                            "name": row["column_name"],
                            "type": row["udt_name"],
                            "nullable": row["is_nullable"] == "YES",
                        }
                        for row in columns
                        if row["table_name"] == name
                    ],
                }
                for name, keys in TABLES.items()
            ],
            "read_only": True,
        }

    @routes.get("/v1/data/postgres/{table}")
    def postgres(table: str, after: Cursor = None, limit: Limit = 25, exact: Exact = None):
        if table not in TABLES:
            raise HTTPException(404, "Unknown catalog table")
        keys = TABLES[table]
        scope = ["postgres", table, exact]
        clauses, params = [], []
        if exact is not None:
            clauses.append(sql.SQL("{}=%s").format(sql.Identifier(keys[0][0])))
            params.append(typed(exact, keys[0][1]))
        if after:
            values = decode_cursor(after, scope)
            if not isinstance(values, list) or len(values) != len(keys):
                raise HTTPException(422, "Invalid primary key cursor")
            columns = sql.SQL(",").join(sql.Identifier(key) for key, _ in keys)
            placeholders = sql.SQL(",").join(
                sql.SQL("%s::{}").format(sql.SQL(kind)) for _, kind in keys
            )
            clauses.append(sql.SQL("({})>({})").format(columns, placeholders))
            params.extend(typed(value, kind) for value, (_, kind) in zip(values, keys, strict=True))
        params.append(limit + 1)
        with app.state.store.transaction() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            conn.execute("SET LOCAL statement_timeout='2000ms'")
            # JSON conversion preserves PostgreSQL infinity timestamps as strings.
            rows = conn.execute(
                sql.SQL(
                    "SELECT to_jsonb(t) AS row FROM public.{} t {} ORDER BY {} LIMIT %s"
                ).format(
                    sql.Identifier(table),
                    sql.SQL("WHERE ") + sql.SQL(" AND ").join(clauses) if clauses else sql.SQL(""),
                    sql.SQL(",").join(sql.Identifier(key) for key, _ in keys),
                ),
                params,
            ).fetchall()
        records = [row["row"] for row in rows[:limit]]
        return {
            "table": table,
            "rows": records,
            "raw_rows": [json.dumps(record, indent=2, ensure_ascii=False) for record in records],
            "next": encode_cursor(scope, [records[-1][key] for key, _ in keys])
            if len(rows) > limit
            else None,
        }

    @routes.get("/v1/data/vectors")
    def vectors(after: Cursor = None, limit: Limit = 25, exact: Exact = None):
        collection = app.state.vectors.collection
        scope = ["vectors", collection, exact]
        offset = None
        if after:
            offset = str(typed(decode_cursor(after, scope), "uuid"))
        try:
            client = app.state.vectors.client
            info = client.get_collection(collection)
            points, next_offset = client.scroll(
                collection,
                limit=limit,
                offset=offset,
                with_payload=True,
                with_vectors=False,
                timeout=3,
                scroll_filter=models.Filter(
                    must=[
                        models.FieldCondition(key="key", match=models.MatchValue(value=exact)),
                    ]
                )
                if exact is not None
                else None,
            )
        except VECTOR_ERRORS as error:
            app.state.log.exception("data_browser_vectors_unavailable")
            raise HTTPException(503, "Qdrant unavailable; retry or browse PostgreSQL") from error
        return {
            "collection": collection,
            "dimensions": DIMENSIONS,
            "reported_points": info.points_count,
            "status": info.status,
            "rows": [{"id": str(point.id), "payload": point.payload} for point in points],
            "next": encode_cursor(scope, str(next_offset)) if next_offset is not None else None,
        }

    @routes.get("/v1/data/vectors/{identifier}")
    def vector(identifier: UUID):
        try:
            points = app.state.vectors.client.retrieve(
                app.state.vectors.collection,
                ids=[str(identifier)],
                with_payload=True,
                with_vectors=True,
                timeout=3,
            )
        except VECTOR_ERRORS as error:
            app.state.log.exception("data_browser_point_unavailable")
            raise HTTPException(503, "Qdrant point unavailable; retry shortly") from error
        if not points:
            raise HTTPException(404, "Vector point not found")
        point = points[0]
        record = {"id": str(point.id), "payload": point.payload, "vector": point.vector}
        return {**record, "raw_json": json.dumps(record, indent=2, ensure_ascii=False)}

    return routes
