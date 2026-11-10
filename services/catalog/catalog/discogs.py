from catalog.model import entity_key, provider_id, text
from catalog.providers import external_identity
from catalog.public_sources import count, entity, rows
from catalog.youtube import Discovery


def metadata(kind, identifier, payload, *, quality=1):
    entity_key("global", kind, identifier, "discogs")
    expected = identifier if kind == "artist" else identifier[1:]
    if str(payload["id"]) != expected:
        raise ValueError("Discogs identity does not match the requested resource")
    credits = rows(payload.get("artists", []), 100)
    genres = rows(payload.get("genres", []), 20)
    return entity(
        "discogs",
        kind,
        identifier,
        payload["name"] if kind == "artist" else payload["title"],
        artist=", ".join(credit["name"] for credit in credits[:3]),
        artists=[str(credit["id"]) for credit in credits],
        genres=genres,
        quality=quality,
    )


def parse(job, payload):
    if "message" in payload and "id" not in payload and "releases" not in payload:
        raise ValueError("Discogs returned an API error")
    kind, identifier = job["kind"], job["provider_id"]
    result = Discovery([], [], [], [])
    if job["task"] == "discogs-albums":
        if kind != "artist":
            raise ValueError("Discogs discography requires an artist ID")
        entity_key("global", kind, identifier, "discogs")
        pagination = payload["pagination"]
        page = job["page"] // 100 + 1
        if (
            job["page"] % 100
            or type(pagination["page"]) is not int
            or type(pagination["per_page"]) is not int
            or pagination["page"] != page
            or pagination["per_page"] != 100
            or type(pagination["pages"]) is not int
            or pagination["pages"] < 0
        ):
            raise ValueError("Invalid Discogs pagination")
        entries = rows(payload["releases"], 100)
        for row in entries:
            if row["type"] not in ("master", "release"):
                raise ValueError("Unknown Discogs discography resource type")
            album_id = ("m" if row["type"] == "master" else "r") + str(row["id"])
            result.entities.append(
                metadata(
                    "album",
                    album_id,
                    {
                        **row,
                        "artists": [{"id": identifier, "name": row.get("artist") or ""}],
                    },
                    quality=0,
                )
            )
        if page < pagination["pages"]:
            if not entries or job["page"] >= 100000:
                raise ValueError("Discogs discography cannot advance within its page budget")
            result.pages.append(("discogs-albums", "artist", identifier, job["page"] + 100))
        return result
    if job["task"] != "discogs-lookup":
        raise ValueError("Unknown Discogs task")
    item = metadata(kind, identifier, payload)
    result.entities.append(item)
    annotation = {
        "record_type": "artist"
        if kind == "artist"
        else "master"
        if identifier.startswith("m")
        else "release",
        "styles": rows(payload.get("styles", []), 100),
    }
    annotation["styles"] = [text(style, 100) for style in annotation["styles"]]
    result.annotations.append((item.key, annotation))
    if kind == "artist":
        result.jobs.append(("discogs-albums", "artist", identifier))
        for url in rows(payload.get("urls", []), 100):
            if not isinstance(url, str):
                raise ValueError("Invalid Discogs external URL")
            identity = external_identity(url)
            if identity:
                source, linked_kind, linked_id = identity
                if linked_kind not in (None, "artist"):
                    continue
                linked_id = provider_id(linked_id, source)
                result.links.append((item.key, source, "artist", linked_id, url))
    else:
        # A master grouping and its main edition remain separate source identities.
        if identifier.startswith("m") and payload.get("main_release"):
            release_id = "r" + str(payload["main_release"])
            entity_key("global", "album", release_id, "discogs")
            annotation["main_release"] = release_id
            result.jobs.append(("discogs-lookup", "album", release_id))
        community = payload.get("community") or {}
        for field in ("have", "want"):
            if community.get(field) is not None:
                result.metrics.append((item, f"discogs_{field}", count(community[field])))
    return result
