import csv
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager

from catalog.bulk_import import MAX_INPUT_BYTES, MAX_LINE_BYTES, import_run
from catalog.model import entity_key
from catalog.public_sources import count, entity
from catalog.youtube import Discovery


TABLES = {
    "artist": "Artists",
    "album": "Albums",
    "song": "Tracks",
    "album-artists": "Artist_Album",
    "song-artists": "Artist_Track",
    "song-features": "Features_Track",
}


def unescape(value):
    if value == r"\N":
        return None
    escapes = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "\\": "\\"}

    def character(match):
        token = match.group(1)
        if token[0] in "01234567":
            return chr(int(token, 8))
        return escapes.get(token, token)

    return re.sub(r"\\([0-7]{1,3}|.)", character, value)


@contextmanager
def copy_rows(path, table):
    executable = shutil.which("pg_restore")
    if not executable:
        raise ValueError("OMDB import requires PostgreSQL client tools (pg_restore)")
    # Inspect/stream data only. Never restore downloaded SQL, functions or DDL.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            [
                executable,
                "--data-only",
                "--no-owner",
                "--no-acl",
                "--file=-",
                f"--table={table}",
                f"--table={table.lower()}",
                str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=errors,
        )

        def iterate():
            columns = None
            finished = False
            total = 0
            while raw := process.stdout.readline(MAX_LINE_BYTES + 1):
                total += len(raw)
                if len(raw) > MAX_LINE_BYTES or total > MAX_INPUT_BYTES:
                    raise ValueError("OMDB export exceeds its line/data byte budget")
                line = raw.decode("utf-8").rstrip("\n")
                if columns is None:
                    match = re.fullmatch(
                        rf'COPY (?:public\.)?"?{re.escape(table)}"? \((.+)\) FROM stdin;',
                        line,
                        re.IGNORECASE,
                    )
                    if match:
                        columns = [
                            column.lower()
                            for column in next(csv.reader([match[1]], skipinitialspace=True))
                        ]
                        if len(set(columns)) != len(columns):
                            raise ValueError("Duplicate OMDB COPY columns")
                    continue
                if line == r"\.":
                    finished = True
                    continue
                if finished:
                    continue
                values = line.split("\t")
                if len(values) != len(columns):
                    raise ValueError("OMDB COPY row has an unexpected column count")
                yield dict(zip(columns, map(unescape, values), strict=True))
            if process.wait(timeout=30):
                errors.seek(0)
                raise ValueError(
                    "pg_restore could not read OMDB data: "
                    + errors.read(2048).decode("utf-8", errors="replace")
                )
            if columns is None or not finished:
                raise ValueError(f"OMDB archive has no complete public.{table} COPY data")

        try:
            yield iterate()
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def parse(kind, row):
    item = entity(
        "omdb",
        kind,
        row["id"],
        row["name"] if kind == "artist" else row["title"],
        albums=[row["album"]] if kind == "song" and row.get("album") else (),
    )
    signal = "subscribers" if kind == "artist" else "views" if kind == "song" else None
    metrics = (
        [(item, f"omdb_{signal}", count(row[signal]))]
        if signal and row.get(signal) is not None
        else []
    )
    return Discovery(
        [item],
        [],
        [],
        [],
        metrics=metrics,
        annotations=[
            (
                item.key,
                {
                    "discovery_source": "omdb_dump",
                    "landing_url": "https://github.com/OatsCG/OMDB",
                    "usage_notice": "Publisher describes the dataset as research-purpose; review its data rights.",
                },
            )
        ],
    )


def import_omdb(store, path, kind, stop=None, *, limit=1000000000):
    if kind not in TABLES or not 1 <= limit <= 1000000000:
        raise ValueError("Select an OMDB metadata/relationship kind and a positive record limit")
    with import_run(store, path, "omdb", kind, stop) as writer:
        if writer.complete:
            return writer.result("complete")
        start, consumed = writer.records, 0
        with copy_rows(path, TABLES[kind]) as entries:
            for ordinal, row in enumerate(entries, 1):
                if stop and stop.is_set():
                    return writer.result("interrupted")
                if ordinal <= start:
                    continue
                if consumed == limit:
                    return writer.result("limited")
                try:
                    if kind in ("artist", "album", "song"):
                        writer.add(parse(kind, row), ordinal)
                    else:
                        source_kind = "album" if kind == "album-artists" else "song"
                        source = entity_key(
                            "global",
                            source_kind,
                            row["album_id" if source_kind == "album" else "track_id"],
                            "omdb",
                        )
                        target = entity_key("global", "artist", row["artist_id"], "omdb")
                        writer.add_edge(source, target, "artist", ordinal)
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"Invalid OMDB {kind} record {ordinal}") from error
                consumed += 1
        return writer.result("complete")
