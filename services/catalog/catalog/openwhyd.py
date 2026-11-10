import logging

from catalog.model import Entity, entity_key, text
from catalog.providers import canonical_url
from catalog.public_sources import count, rows
from catalog.youtube import Discovery


log = logging.getLogger(__name__)


def parse(payload):
    entries = rows(payload["tracks"], 20)
    result = Discovery([], [], [], [])
    unsupported = 0
    seen = set()
    for row in entries:
        identifier = row["eId"]
        if not isinstance(identifier, str) or len(identifier) > 2048:
            raise ValueError("Invalid Openwhyd external identity")
        if identifier.startswith("/yt/"):
            source, identifier = "youtube", identifier[4:]
        elif identifier.startswith("/sc/"):
            source = "soundcloud"
            parts = identifier[4:].split("#", 1)[0].split("/")
            if len(parts) != 2:
                raise ValueError("Openwhyd SoundCloud identity requires user and track slugs")
            identifier = "~".join(parts)
        else:
            unsupported += 1
            continue
        key = entity_key("global", "song", identifier, source)
        if key in seen:
            continue
        seen.add(key)
        item = Entity(
            key,
            "global",
            "song",
            identifier,
            text(row["name"]),
            "",
            "",
            (),
            f"https://www.youtube.com/watch?v={identifier}"
            if source == "youtube"
            else canonical_url(source, "song", identifier),
            source=source,
            origin="openwhyd",
            quality=0,
        )
        result.entities.append(item)
        result.annotations.append(
            (
                key,
                {
                    "discovery_source": "openwhyd",
                    "landing_url": "https://openwhyd.org/hot",
                },
            )
        )
        for field, signal in (("nbP", "posts"), ("nbR", "reposts"), ("nbL", "likes")):
            if row.get(field) is not None:
                result.metrics.append((item, f"openwhyd_{signal}", count(row[field])))
    log.info("openwhyd_discovery accepted=%s unsupported=%s", len(result.entities), unsupported)
    return result
