import unicodedata
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Track(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: Annotated[str, Field(min_length=1, max_length=200)]
    title: Annotated[str, Field(max_length=500)] = ""
    artist: Annotated[str, Field(max_length=500)] = ""
    album: Annotated[str, Field(max_length=500)] = ""
    duration_ms: Annotated[int | None, Field(strict=True, gt=0, le=86400000)] = None
    track_number: Annotated[int | None, Field(strict=True, gt=0, le=10000)] = None
    recording_mbid: str | None = None
    sha256: Annotated[str | None, Field(pattern=r"^[0-9a-fA-F]{64}$")] = None

    @field_validator("recording_mbid")
    @classmethod
    def valid_mbid(cls, value):
        if value is not None:
            if len(value) != 36 or str(UUID(value)) != value.lower():
                raise ValueError("recording_mbid must be a canonical MusicBrainz recording UUID")
            return value.lower()
        return value

    @field_validator("sha256")
    @classmethod
    def normalize_hash(cls, value):
        return value.lower() if value is not None else None

    @field_validator("id")
    @classmethod
    def meaningful_id(cls, value):
        if not value:
            raise ValueError("id must not be blank")
        return value


class AuditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tracks: Annotated[list[Track], Field(min_length=1, max_length=5000)]
    reconcile: bool = False
    max_findings: Annotated[int, Field(strict=True, ge=1, le=1000)] = 200

    @model_validator(mode="after")
    def valid_manifest(self):
        if len({track.id for track in self.tracks}) != len(self.tracks):
            raise ValueError("Manifest track IDs must be unique")
        if self.reconcile and len(self.tracks) > 100:
            raise ValueError("Catalog reconciliation accepts at most 100 tracks per audit")
        return self


def normalize(value):
    return " ".join(
        "".join(
            character if character.isalnum() else " "
            for character in unicodedata.normalize("NFKD", value.casefold())
            if not unicodedata.combining(character)
        ).split()
    )
