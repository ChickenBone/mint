import asyncio
import threading
import unicodedata
from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.responses import JSONResponse

from catalog.model import entity_key, provider_id
from catalog.providers import EntitySource


VERSION = "recording-reconciliation-v1"
MAX_CANDIDATES = 50
VERSION_WORDS = frozenset(
    (
        "live",
        "remix",
        "remastered",
        "remaster",
        "instrumental",
        "acoustic",
        "karaoke",
        "demo",
        "edit",
        "mono",
        "stereo",
        "sped",
        "slowed",
    )
)


class ReconciliationBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] not in ("/v1/reconcile/recordings", "/v1/demand")
        ):
            return await self.app(scope, receive, send)
        body = bytearray()
        try:
            async with asyncio.timeout(10):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > 32768:
                        return await JSONResponse(
                            {"detail": "Request body exceeds 32 KiB"},
                            status_code=413,
                        )(scope, receive, send)
                    if not message.get("more_body"):
                        break
        except TimeoutError:
            return await JSONResponse(
                {"detail": "Reconciliation input timed out"},
                status_code=408,
            )(scope, receive, send)
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def normalize(value):
    return " ".join(
        "".join(
            character if character.isalnum() else " "
            for character in unicodedata.normalize("NFKD", value.casefold())
            if not unicodedata.combining(character)
        ).split()
    )


class Reference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: EntitySource
    identifier: Annotated[str, Field(min_length=1, max_length=128)]
    country: Annotated[str, Field(pattern=r"^(?:[a-z]{2}|global)$")] = "global"

    @model_validator(mode="after")
    def valid_identifier(self):
        entity_key(self.country, "song", self.identifier, self.source)
        self.identifier = provider_id(self.identifier, self.source)
        return self

    def key(self):
        return entity_key(self.country, "song", self.identifier, self.source)


class RecordingQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: Annotated[str, Field(max_length=500)] = ""
    artist: Annotated[str, Field(max_length=500)] = ""
    album: Annotated[str, Field(max_length=500)] = ""
    duration_ms: Annotated[int | None, Field(strict=True, gt=0, le=86400000)] = None
    references: Annotated[list[Reference], Field(max_length=5)] = Field(default_factory=list)

    @model_validator(mode="after")
    def sufficient_evidence(self):
        if not self.references and not (normalize(self.title) and normalize(self.artist)):
            raise ValueError("Supply title and artist, or at least one explicit provider reference")
        return self


def assess(query, row, evidence):
    reasons = list(evidence)
    conflicts = []
    title, candidate_title = normalize(query.title), normalize(row["title"])
    artist, candidate_artist = normalize(query.artist), normalize(row["artist"])
    score = 0
    if title and title == candidate_title:
        reasons.append({"code": "title_exact"})
        score += 60
    elif title:
        conflicts.append("title_mismatch")
    if artist and artist == candidate_artist:
        reasons.append({"code": "artist_exact"})
        score += 30
    elif artist:
        conflicts.append("artist_mismatch")
    if query.album and normalize(query.album) == normalize(row["album"]):
        reasons.append({"code": "album_exact"})
        score += 5
    if title and (
        set(title.split()) & VERSION_WORDS != set(candidate_title.split()) & VERSION_WORDS
    ):
        conflicts.append("version_mismatch")
    duration = row.get("metadata", {}).get("duration_ms")
    if query.duration_ms is not None and type(duration) is int and duration > 0:
        delta = abs(query.duration_ms - duration)
        if delta <= 2000:
            reasons.append({"code": "duration_within_2s", "difference_ms": delta})
            score += 5
        else:
            conflicts.append("duration_mismatch")
    identified = bool(evidence)
    return {
        **{
            field: row[field]
            for field in (
                "key",
                "source",
                "provider_id",
                "title",
                "artist",
                "album",
                "url",
                "observed_at",
            )
        },
        "duration_ms": duration,
        "evidence": reasons,
        "conflicts": conflicts,
        "match_type": "explicit_identifier" if identified else "metadata_candidate",
        "rank_score": score,
        "review_required": bool(conflicts) or not identified,
    }


def reconcile(conn, query):
    evidence = {}
    overflow = False
    explicit_sets = []
    for reference in query.references:
        keys = [reference.key()]
        if reference.source in ("youtube", "ytmusic"):
            alternate = "ytmusic" if reference.source == "youtube" else "youtube"
            keys.append(entity_key("global", "song", reference.identifier, alternate))
        found = set()
        for key in keys:
            evidence.setdefault(key, []).append(
                {
                    "code": "provider_id",
                    "source": reference.source,
                    "identifier": reference.identifier,
                }
            )
            found.add(key)
        # A retained authority link is evidence, not a title-derived equivalence.
        links = conn.execute(
            """SELECT l.key,l.url,l.observed_at,e.source AS authority FROM entity_links l
               JOIN entities e ON e.key=l.key
               WHERE l.provider=%s AND l.kind='song' AND l.identifier=%s
               AND l.canonical_status NOT IN ('excluded','conflict')
               AND e.kind='song' AND e.source IN ('musicbrainz','wikidata')
               ORDER BY l.key LIMIT 51""",
            (reference.source, reference.identifier),
        ).fetchall()
        overflow |= len(links) > MAX_CANDIDATES
        for link in links[:MAX_CANDIDATES]:
            evidence.setdefault(link["key"], []).append(
                {
                    "code": "authority_link",
                    "authority": link["authority"],
                    "url": link["url"],
                    "source": reference.source,
                    "identifier": reference.identifier,
                    "observed_at": link["observed_at"],
                }
            )
            found.add(link["key"])
        targets = conn.execute(
            """SELECT t.key,l.url,l.observed_at,e.source AS authority,l.provider,l.identifier
               FROM entities e JOIN entity_links l ON l.key=e.key
               JOIN entities t ON t.source=l.provider AND t.provider_id=l.identifier
                 AND t.kind='song'
               WHERE e.key=ANY(%s) AND e.source IN ('musicbrainz','wikidata')
                 AND l.kind='song' AND l.canonical_status NOT IN ('excluded','conflict')
               ORDER BY t.key,l.provider,l.identifier LIMIT 51""",
            (list(found),),
        ).fetchall()
        overflow |= len(targets) > MAX_CANDIDATES
        for target in targets[:MAX_CANDIDATES]:
            evidence.setdefault(target["key"], []).append(
                {
                    "code": "authority_link",
                    "authority": target["authority"],
                    "url": target["url"],
                    "source": target["provider"],
                    "identifier": target["identifier"],
                    "observed_at": target["observed_at"],
                }
            )
            found.add(target["key"])
        explicit_sets.append(found)
    keys = list(evidence)
    lexical_overflow = False
    if normalize(query.title) and normalize(query.artist):
        # AND title tokens first; bounded FTS candidates, never a full-library fuzzy scan.
        rows = conn.execute(
            """SELECT key FROM entities,plainto_tsquery('simple',%s) q
               WHERE kind='song' AND search@@q
               ORDER BY ts_rank_cd(search,q) DESC,popularity DESC,key LIMIT 51""",
            (query.title + " " + query.artist,),
        ).fetchall()
        lexical_overflow = len(rows) > MAX_CANDIDATES
        keys.extend(row["key"] for row in rows[:MAX_CANDIDATES])
    rows = conn.execute(
        """SELECT e.key,e.source,e.provider_id,e.title,e.artist,e.album,e.url,e.observed_at,
                  COALESCE(a.metadata,'{}'::jsonb) AS metadata
           FROM entities e LEFT JOIN entity_annotations a ON a.key=e.key
           WHERE e.kind='song' AND e.key=ANY(%s) ORDER BY e.key""",
        (keys,),
    ).fetchall()
    candidates = [assess(query, row, evidence.get(row["key"], [])) for row in rows]
    candidates.sort(
        key=lambda row: (
            row["match_type"] != "explicit_identifier",
            bool(row["conflicts"]),
            -row["rank_score"],
            row["key"],
        )
    )
    identified = [row for row in candidates if row["match_type"] == "explicit_identifier"]
    # Two authorities asserting different records for the same provider ID are ambiguous.
    authorities = [row for row in identified if row["source"] in ("musicbrainz", "wikidata")]
    by_source = {}
    for row in authorities:
        by_source.setdefault(row["source"], set()).add(row["provider_id"])
    conflicting_ids = any(len(ids) > 1 for ids in by_source.values())
    conflicts = ["multiple_authority_recordings"] if conflicting_ids else []
    if len(explicit_sets) > 1 and not set.intersection(*explicit_sets):
        conflicts.append("disconnected_references")
    if overflow and identified:
        conflicts.append("candidate_window_truncated")
    if any(row["conflicts"] for row in identified):
        conflicts.append("metadata_conflict")
    if identified:
        status = "ambiguous" if conflicts else "identified"
    else:
        status = "candidates" if candidates else "no_match"
    return {
        "version": VERSION,
        "status": status,
        "conflicts": conflicts,
        "review_required": status != "identified",
        "candidates": candidates[:10],
        "candidates_truncated": overflow or lexical_overflow or len(candidates) > 10,
        "automatic_merge": False,
        "score_notice": "rank_score orders metadata evidence; it is not a match probability",
    }


def router(app):
    routes = APIRouter()
    capacity = threading.BoundedSemaphore(4)

    @routes.post("/v1/reconcile/recordings")
    def recording_matches(query: RecordingQuery):
        import psycopg

        if not capacity.acquire(blocking=False):
            raise HTTPException(
                503, "Reconciliation capacity reached", headers={"Retry-After": "1"}
            )
        try:
            with app.state.store.transaction() as conn:
                conn.execute("SET TRANSACTION READ ONLY")
                conn.execute("SET LOCAL statement_timeout='2000ms'")
                return reconcile(conn, query)
        except psycopg.Error as error:
            app.state.log.exception("recording_reconciliation_failed")
            raise HTTPException(503, "Recording reconciliation unavailable") from error
        finally:
            capacity.release()

    return routes
