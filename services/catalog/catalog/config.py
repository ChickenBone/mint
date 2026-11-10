import os
import re
import math
from dataclasses import dataclass


MINIMUM_INTERVALS = {"musicbrainz": 1.0, "discogs": 2.5, "openwhyd": 2.0}


def integer(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def interval(value: str, name: str) -> float:
    try:
        seconds = float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number between 0.1 and 3600 seconds") from error
    if not math.isfinite(seconds) or not 0.1 <= seconds <= 3600:
        raise ValueError(f"{name} must be between 0.1 and 3600 seconds")
    return seconds


def source_intervals() -> tuple[tuple[str, float], ...]:
    from catalog.providers import SOURCES

    values = {}
    for entry in filter(None, os.getenv("SOURCE_INTERVAL_OVERRIDES", "").split(",")):
        source, separator, value = entry.partition("=")
        if not separator or source not in SOURCES or source in values:
            raise ValueError(
                "SOURCE_INTERVAL_OVERRIDES requires unique supported source=seconds pairs"
            )
        values[source] = interval(value, "SOURCE_INTERVAL_OVERRIDES")
        if source in MINIMUM_INTERVALS and values[source] < MINIMUM_INTERVALS[source]:
            raise ValueError(
                f"SOURCE_INTERVAL_OVERRIDES: {source} requires at least {MINIMUM_INTERVALS[source]:g} seconds"
            )
    return tuple(values.items())


@dataclass(frozen=True)
class Settings:
    database_url: str
    qdrant_url: str
    countries: tuple[str, ...]
    apple_enabled: bool
    musicbrainz_enabled: bool
    listenbrainz_enabled: bool
    user_agent: str
    model_cache: str
    collection: str
    max_entities: int
    source_interval: float
    chart_interval: int
    lease_seconds: int = 300
    max_attempts: int = 8
    batch_size: int = 64
    crawler_workers: int = 8
    indexer_workers: int = 2
    embedding_threads: int = 2
    youtube_enabled: bool = False
    ytmusic_enabled: bool = False
    youtube_channels: tuple[str, ...] = ()
    public_sources: tuple[str, ...] = ()
    source_intervals: tuple[tuple[str, float], ...] = ()

    @classmethod
    def load(cls) -> "Settings":
        from catalog.providers import PUBLIC_SOURCES

        public_sources = tuple(filter(None, os.getenv("PUBLIC_SOURCES", "").split(",")))
        if len(set(public_sources)) != len(public_sources) or set(public_sources) - set(
            PUBLIC_SOURCES
        ):
            raise ValueError("PUBLIC_SOURCES contains duplicate or unsupported adapter names")
        countries = tuple(dict.fromkeys(os.getenv("COUNTRIES", "us").lower().split(",")))
        if (
            not countries
            or len(countries) > 50
            or any(not re.fullmatch("[a-z]{2}", country) for country in countries)
        ):
            raise ValueError("COUNTRIES must contain 1..50 comma-separated two-letter storefronts")
        enabled = os.getenv("APPLE_ENABLED", "false").lower()
        if enabled not in ("true", "false"):
            raise ValueError("APPLE_ENABLED must be true or false")
        flags = {}
        for name in (
            "MUSICBRAINZ_ENABLED",
            "LISTENBRAINZ_ENABLED",
            "YOUTUBE_ENABLED",
            "YTMUSIC_ENABLED",
        ):
            value = os.getenv(name, "true" if name.endswith("BRAINZ_ENABLED") else "false").lower()
            if value not in ("true", "false"):
                raise ValueError(f"{name} must be true or false")
            flags[name] = value == "true"
        user_agent = os.getenv("CRAWLER_USER_AGENT", "")
        if not user_agent or len(user_agent) > 250 or "\n" in user_agent or "\r" in user_agent:
            raise ValueError(
                "Set CRAWLER_USER_AGENT to an application/version and contact URL/email"
            )
        collection = os.getenv("VECTOR_COLLECTION", "catalog_minilm_v1")
        if not re.fullmatch("[a-zA-Z0-9_-]{1,100}", collection):
            raise ValueError("Invalid VECTOR_COLLECTION")
        channels = tuple(filter(None, os.getenv("YOUTUBE_CHANNELS", "").split(",")))
        if len(channels) > 50 or any(
            not re.fullmatch("UC[a-zA-Z0-9_-]{22}", channel) for channel in channels
        ):
            raise ValueError("YOUTUBE_CHANNELS must contain at most 50 comma-separated channel IDs")
        return cls(
            database_url=os.environ["DATABASE_URL"],
            qdrant_url=os.getenv("QDRANT_URL", "http://qdrant:6333"),
            countries=countries,
            apple_enabled=enabled == "true",
            musicbrainz_enabled=flags["MUSICBRAINZ_ENABLED"],
            listenbrainz_enabled=flags["LISTENBRAINZ_ENABLED"],
            user_agent=user_agent,
            model_cache=os.getenv("MODEL_CACHE", "/models"),
            collection=collection,
            max_entities=integer("MAX_ENTITIES", 10_000_000, 100, 1_000_000_000),
            source_interval=interval(
                os.getenv("SOURCE_INTERVAL_SECONDS", "4"), "SOURCE_INTERVAL_SECONDS"
            ),
            source_intervals=source_intervals(),
            chart_interval=integer("CHART_INTERVAL_SECONDS", 21600, 3600, 604800),
            batch_size=integer("INDEX_BATCH_SIZE", 64, 1, 256),
            crawler_workers=integer("CRAWLER_WORKERS", 8, 1, 32),
            indexer_workers=integer("INDEXER_WORKERS", 2, 1, 8),
            embedding_threads=integer("EMBEDDING_THREADS", 2, 1, 32),
            youtube_enabled=flags["YOUTUBE_ENABLED"],
            ytmusic_enabled=flags["YTMUSIC_ENABLED"],
            youtube_channels=channels,
            public_sources=public_sources,
        )

    def request_interval(self, source: str, host: str | None = None) -> float:
        seconds = dict(self.source_intervals).get(
            source, 1.0 if source == "musicbrainz" else self.source_interval
        )
        minimum = MINIMUM_INTERVALS.get(source, 0)
        if host in ("musicbrainz.org", "api.discogs.com", "openwhyd.org"):
            host_minimum = {
                "musicbrainz.org": 1, "api.discogs.com": 2.5, "openwhyd.org": 2,
            }[host]
            minimum = max(minimum, host_minimum)
        return max(minimum, seconds)

    def enabled(self, source: str) -> bool:
        from catalog.providers import PUBLIC_SOURCES

        if source == "omdb":
            return False
        if source in PUBLIC_SOURCES:
            return source in self.public_sources
        return {
            "apple": self.apple_enabled,
            "musicbrainz": self.musicbrainz_enabled,
            "listenbrainz": self.listenbrainz_enabled,
            "youtube": self.youtube_enabled,
            "ytmusic": self.ytmusic_enabled,
        }[source]
