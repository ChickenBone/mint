import gzip
import logging
from contextlib import contextmanager

from defusedxml.ElementTree import iterparse

from catalog.discogs import parse


log = logging.getLogger(__name__)
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024 * 1024


class BoundedReader:
    def __init__(self, stream):
        self.stream = stream
        self.total = 0
        self.record_bytes = 0

    def read(self, size=-1):
        data = self.stream.read(min(size, 4096) if size >= 0 else 4096)
        self.total += len(data)
        self.record_bytes += len(data)
        if self.total > MAX_XML_BYTES or self.record_bytes > MAX_RECORD_BYTES:
            raise ValueError("Discogs XML exceeds its decompressed file/record byte budget")
        return data


@contextmanager
def records(path, kind):
    root_tag = {"artist": "artists", "master": "masters", "release": "releases"}[kind]
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rb") as stream:
        reader = BoundedReader(stream)

        def iterate():
            depth, root = 0, None
            for event, node in iterparse(
                reader,
                events=("start", "end"),
                forbid_dtd=True,
                forbid_entities=True,
                forbid_external=True,
            ):
                if event == "start":
                    depth += 1
                    if depth == 1:
                        if node.tag != root_tag:
                            raise ValueError(f"Expected Discogs {root_tag} XML root")
                        root = node
                    if depth > 32:
                        raise ValueError("Discogs XML exceeds its nesting budget")
                else:
                    if depth == 2:
                        if node.tag != kind:
                            raise ValueError("Unexpected top-level Discogs record")
                        yield node
                        root.remove(node)
                        node.clear()
                        reader.record_bytes = 0
                    depth -= 1

        yield iterate()


def discovery(node, kind):
    identifier = node.findtext("id") if kind == "artist" else node.attrib["id"]
    row = {
        "id": identifier,
        "name" if kind == "artist" else "title": node.findtext(
            "name" if kind == "artist" else "title"
        ),
        "artists": [
            {"id": artist.findtext("id"), "name": artist.findtext("name")}
            for artist in node.findall("./artists/artist")
        ],
        "genres": [genre.text for genre in node.findall("./genres/genre")],
        "styles": [style.text for style in node.findall("./styles/style")],
    }
    if kind == "master":
        row["main_release"] = node.findtext("main_release")
    identifier = (
        str(identifier)
        if kind == "artist"
        else ("m" if kind == "master" else "r") + str(identifier)
    )
    result = parse(
        {
            "task": "discogs-lookup",
            "kind": "artist" if kind == "artist" else "album",
            "provider_id": identifier,
        },
        row,
    )
    for _, annotation in result.annotations:
        annotation.update(
            {
                "source_data_license": "CC0-1.0",
                "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
                "landing_url": "https://data.discogs.com/",
            }
        )
    return result


def import_discogs(store, path, kind, stop=None, *, limit=100000):
    if kind not in ("artist", "master", "release") or not 1 <= limit <= 10000000:
        raise ValueError("Select artist/master/release and a limit between 1 and 10000000")
    total, batch, annotations = 0, [], []

    def flush():
        nonlocal total
        with store.transaction() as conn:
            store.ingest(conn, batch, schedule=False)
            # Dump parsing emits no crosswalks or counts; never enqueue online expansions.
            from catalog.youtube import Discovery

            store.public_observations(conn, Discovery([], [], [], [], annotations=annotations))
            store.activity(
                conn,
                "importer",
                "imported",
                "Discogs CC0 dump observations",
                source="discogs",
                amount=len(batch),
            )
        total += len(batch)
        log.info("discogs_import observations=%s", total)
        batch.clear()
        annotations.clear()

    with records(path, kind) as entries:
        while not (stop and stop.is_set()) and total + len(batch) < limit:
            try:
                node = next(entries)
            except StopIteration:
                break
            try:
                result = discovery(node, kind)
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(
                    f"Invalid Discogs {kind} record {total + len(batch) + 1}"
                ) from error
            batch.extend(result.entities)
            annotations.extend(result.annotations)
            if len(batch) == 128:
                flush()
        if batch:
            flush()
    return {
        "imported": total,
        "status": "interrupted"
        if stop and stop.is_set()
        else "limited"
        if total == limit
        else "complete",
    }
