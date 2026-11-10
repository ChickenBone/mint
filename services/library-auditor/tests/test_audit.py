import copy

import pytest
from pydantic import ValidationError

from auditor.audit import audit
from auditor.model import AuditRequest


MBID = "00000000-0000-4000-8000-000000000001"


def track(identifier, **extra):
    return {
        "id": identifier,
        "title": "Northern Lights",
        "artist": "Example Artist",
        "album": "Fixture Album",
        "duration_ms": 180000,
        "track_number": 1,
        **extra,
    }


def test_audit_hash_claims_and_missing_fields_never_mutate_input():
    data = {"tracks": [track("a", sha256="a" * 64), track("b", sha256="a" * 64), {"id": "c"}]}
    original = copy.deepcopy(data)
    report = audit(AuditRequest.model_validate(data))
    assert data == original
    assert report["findings_by_code"] == {"identical_content_claim": 1, "metadata_gaps": 1}
    assert report["findings_total"] == 2
    assert not report["files_read"] and not report["files_modified"]
    assert not report["automatic_actions"]


def test_recording_id_repetition_is_not_a_file_duplicate():
    manifest = AuditRequest(
        tracks=[
            track("a", recording_mbid=MBID),
            track(
                "b",
                recording_mbid=MBID,
                album="Compilation",
                title="Northern Lights (Live)",
                duration_ms=240000,
            ),
        ]
    )
    report = audit(manifest)
    assert report["findings_by_code"] == {
        "recording_identifier_conflict": 1,
        "repeated_recording_identifier": 1,
    }
    assert all(f["action"] == "review_only" for f in report["findings"])


def test_metadata_duplicates_preserve_versions_artists_and_duration_span():
    report = audit(
        AuditRequest(
            tracks=[
                track("a"),
                track("b", title="NÓRTHERN LIGHTS", duration_ms=182000),
                track("c", duration_ms=184000),
                track("live", title="Northern Lights (Live)"),
                track("other", artist="Different Artist"),
            ]
        )
    )
    possible = [f for f in report["findings"] if f["code"] == "possible_metadata_duplicate"]
    assert len(possible) == 1
    assert possible[0]["track_ids"] == ["a", "b"]
    assert possible[0]["confidence"] == "metadata_only"


def test_truncated_findings_keep_exact_counts_and_deterministic_order():
    manifest = AuditRequest(tracks=[{"id": str(i)} for i in range(5000)], max_findings=3)
    report = audit(manifest)
    assert report == audit(manifest)
    assert report["tracks_scanned"] == report["findings_total"] == 5000
    assert report["findings_truncated"] and len(report["findings"]) == 3


@pytest.mark.parametrize(
    "data",
    [
        {"tracks": []},
        {"tracks": [track("a"), track("a")]},
        {"tracks": [track(" ")]},
        {"tracks": [track("a", duration_ms=True)]},
        {"tracks": [track("a", recording_mbid="bad")]},
        {"tracks": [track("a", sha256="bad")]},
        {"tracks": [track("a", path="/etc/passwd")]},
        {"tracks": [track(str(i)) for i in range(101)], "reconcile": True},
    ],
)
def test_invalid_manifests_are_explicit_errors(data):
    with pytest.raises(ValidationError):
        AuditRequest.model_validate(data)
