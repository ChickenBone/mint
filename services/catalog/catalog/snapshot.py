import hashlib
import logging
import re
import shutil
from pathlib import Path

import httpx

from catalog.musicbrainz_import import import_musicbrainz


log = logging.getLogger(__name__)
ROOT = "https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/"
KINDS = ("artist", "release-group", "recording", "release")
MAX_DOWNLOAD_BYTES = 128 * 1024**3


def small_text(client, url):
    with client.stream("GET", url) as response:
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > 65536:
                raise ValueError("Snapshot manifest exceeds 64 KiB")
    return data.decode("utf-8")


def verified(path, checksum, stop=None):
    if not path.exists():
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024**2):
            if stop and stop.is_set():
                raise InterruptedError("Snapshot verification interrupted")
            digest.update(chunk)
    if digest.hexdigest() != checksum:
        raise ValueError(f"SHA-256 mismatch for {path.name}; file retained, not imported")
    return True


def download(client, url, path, checksum, stop=None):
    if verified(path, checksum, stop):
        return True
    partial = path.with_name(path.name + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    with client.stream(
        "GET",
        url,
        headers={"Range": f"bytes={offset}-"} if offset else {},
    ) as response:
        response.raise_for_status()
        if offset and response.status_code != 206:
            raise ValueError(
                "Snapshot server did not honor the resume range; partial file retained"
            )
        if offset:
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith(f"bytes {offset}-"):
                raise ValueError("Snapshot resume returned a mismatched byte range")
        length = response.headers.get("Content-Length")
        if length is None or not length.isdecimal():
            raise ValueError("Snapshot download requires an explicit content length")
        expected = offset + int(length)
        if expected > MAX_DOWNLOAD_BYTES:
            raise ValueError("Snapshot exceeds its 128 GiB compressed download budget")
        if shutil.disk_usage(path.parent).free < int(length) + 1024**3:
            raise ValueError("Insufficient free disk for the snapshot plus a 1 GiB reserve")
        log.info("snapshot_download file=%s offset=%s bytes=%s", path.name, offset, expected)
        with partial.open("ab") as stream:
            for chunk in response.iter_bytes(1024**2):
                if stop and stop.is_set():
                    return False
                offset += len(chunk)
                if offset > expected:
                    raise ValueError("Snapshot response exceeded its declared size")
                stream.write(chunk)
        if offset != expected:
            raise ValueError("Snapshot download ended before its declared size")
    verified(partial, checksum, stop)
    partial.replace(path)
    log.info("snapshot_verified file=%s bytes=%s", path.name, expected)
    return True


def load_musicbrainz(store, directory, stop=None, *, snapshot=None, kinds=KINDS):
    if not kinds or any(kind not in KINDS for kind in kinds):
        raise ValueError("Unsupported MusicBrainz snapshot kind")
    with httpx.Client(
        timeout=httpx.Timeout(120, connect=30),
        follow_redirects=False,
        headers={"User-Agent": store.settings.user_agent, "Accept-Encoding": "identity"},
    ) as client:
        snapshot = snapshot or small_text(client, ROOT + "LATEST").strip()
        if not re.fullmatch(r"[0-9]{8}-[0-9]{6}", snapshot):
            raise ValueError("Invalid MusicBrainz snapshot identifier")
        directory = Path(directory) / snapshot
        directory.mkdir(parents=True, exist_ok=True)
        base = ROOT + snapshot + "/"
        manifest = small_text(client, base + "SHA256SUMS")
        checksums = {}
        for line in manifest.splitlines():
            match = re.fullmatch(r"([0-9a-f]{64}) [ *]([a-z-]+\.tar\.xz)", line)
            if not match:
                raise ValueError("Invalid official snapshot checksum manifest")
            checksums[match[2]] = match[1]
        results = []
        for kind in kinds:
            if stop and stop.is_set():
                break
            name = kind + ".tar.xz"
            if name not in checksums:
                raise ValueError("Requested snapshot archive is absent from the official manifest")
            path = directory / name
            if not download(client, base + name, path, checksums[name], stop):
                break
            result = import_musicbrainz(store, path, kind, stop)
            log.info("snapshot_import kind=%s result=%s", kind, result)
            results.append(result)
    return {
        "snapshot": snapshot,
        "imports": results,
        "status": "interrupted" if stop and stop.is_set() else "complete",
    }
