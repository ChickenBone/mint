import asyncio
import json
from urllib.parse import urlsplit

import httpx

from auditor.model import normalize


class CatalogUnavailable(Exception):
    pass


def validate_url(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ValueError("CATALOG_URL must be an HTTP(S) origin without credentials or a path")
    return value.rstrip("/")


async def reconcile_tracks(tracks, url, *, transport=None):
    url = validate_url(url)
    semaphore = asyncio.Semaphore(4)
    async with httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(5),
        follow_redirects=False,
        headers={"Host": "localhost", "User-Agent": "MintLibraryAuditor/0.1"},
        trust_env=False,
    ) as client:

        async def resolve(track):
            references = []
            if track.recording_mbid:
                references.append({"source": "musicbrainz", "identifier": track.recording_mbid})
            if not references and not (normalize(track.title) and normalize(track.artist)):
                return track.id, None
            payload = {
                "title": track.title,
                "artist": track.artist,
                "album": track.album,
                "duration_ms": track.duration_ms,
                "references": references,
            }
            async with semaphore:
                async with client.stream(
                    "POST",
                    url + "/v1/reconcile/recordings",
                    json=payload,
                ) as response:
                    response.raise_for_status()
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 262144:
                            raise CatalogUnavailable(
                                "Catalog reconciliation response exceeds 256 KiB"
                            )
                result = json.loads(body)
                if (
                    not isinstance(result, dict)
                    or result.get("version") != "recording-reconciliation-v1"
                    or result.get("status")
                    not in ("identified", "ambiguous", "candidates", "no_match")
                    or not isinstance(result.get("candidates"), list)
                    or len(result["candidates"]) > 10
                    or result.get("automatic_merge") is not False
                ):
                    raise CatalogUnavailable(
                        "Catalog returned an incompatible reconciliation response"
                    )
                candidates = result["candidates"]
                if any(
                    not isinstance(candidate, dict)
                    or candidate.get("match_type")
                    not in ("explicit_identifier", "metadata_candidate")
                    or not isinstance(candidate.get("evidence"), list)
                    or not isinstance(candidate.get("conflicts"), list)
                    for candidate in candidates
                ):
                    raise CatalogUnavailable("Catalog returned malformed candidate evidence")
                if (result["status"] != "no_match" and not candidates) or (
                    result["status"] == "no_match" and candidates
                ):
                    raise CatalogUnavailable("Catalog returned inconsistent match status")
                if result["status"] == "identified":
                    explicit = [
                        candidate
                        for candidate in candidates
                        if candidate["match_type"] == "explicit_identifier"
                    ]
                    if not explicit or any(candidate["conflicts"] for candidate in explicit):
                        raise CatalogUnavailable(
                            "Catalog identity has no consistent supporting identifier evidence"
                        )
                return track.id, result

        try:
            async with asyncio.timeout(30):
                async with asyncio.TaskGroup() as group:
                    tasks = [group.create_task(resolve(track)) for track in tracks]
                results = [task.result() for task in tasks]
        except* (httpx.HTTPError, TimeoutError, ValueError, CatalogUnavailable) as error:
            raise CatalogUnavailable(
                "Catalog reconciliation failed; no complete audit produced"
            ) from error
    return {key: result for key, result in results if result is not None}
