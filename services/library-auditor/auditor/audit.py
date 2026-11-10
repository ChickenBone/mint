from collections import Counter, defaultdict

from auditor.model import AuditRequest, normalize


VERSION = "library-audit-v1"


def audit(manifest: AuditRequest, matches=None):
    findings = []

    def add(code, tracks, evidence, confidence, severity="review"):
        findings.append(
            {
                "code": code,
                "track_ids": sorted(track.id for track in tracks),
                "severity": severity,
                "confidence": confidence,
                "evidence": evidence,
                "action": "review_only",
            }
        )

    hashes, recordings, metadata = defaultdict(list), defaultdict(list), defaultdict(list)
    matchable = 0
    for track in manifest.tracks:
        missing = [
            field for field in ("title", "artist", "album") if not normalize(getattr(track, field))
        ]
        missing.extend(
            field for field in ("duration_ms", "track_number") if getattr(track, field) is None
        )
        if missing:
            add("metadata_gaps", [track], {"missing": missing}, "observed", "info")
        if track.sha256:
            hashes[track.sha256].append(track)
        if track.recording_mbid:
            recordings[track.recording_mbid].append(track)
        if all(normalize(getattr(track, field)) for field in ("title", "artist", "album")):
            if track.duration_ms is not None:
                metadata[
                    tuple(
                        normalize(getattr(track, field)) for field in ("title", "artist", "album")
                    )
                ].append(track)
        if track.recording_mbid or (normalize(track.title) and normalize(track.artist)):
            matchable += 1
        if matches is not None:
            result = matches.get(track.id)
            if result is None:
                add("insufficient_match_metadata", [track], {}, "observed", "info")
            elif result["status"] in ("ambiguous", "candidates"):
                add("catalog_match_review", [track], result, "unverified")
            elif result["status"] == "no_match":
                add("catalog_no_match", [track], result, "coverage_limited", "info")
            elif result["status"] == "identified":
                add("catalog_identifier_match", [track], result, "identifier_claim", "info")
    for checksum, tracks in sorted(hashes.items()):
        if len(tracks) > 1:
            add(
                "identical_content_claim",
                tracks,
                {
                    "sha256": checksum,
                    "notice": "Equal caller-supplied whole-file hashes; files were not read or verified",
                },
                "caller_supplied_hash",
            )
    for mbid, tracks in sorted(recordings.items()):
        if len(tracks) > 1:
            add(
                "repeated_recording_identifier",
                tracks,
                {
                    "recording_mbid": mbid,
                    "notice": "Repeated recording identity may be intentional across releases",
                },
                "identifier_claim",
                "info",
            )
            names = {
                (normalize(track.title), normalize(track.artist))
                for track in tracks
                if normalize(track.title) and normalize(track.artist)
            }
            durations = [track.duration_ms for track in tracks if track.duration_ms is not None]
            if len(names) > 1 or (durations and max(durations) - min(durations) > 2000):
                add(
                    "recording_identifier_conflict",
                    tracks,
                    {
                        "recording_mbid": mbid,
                        "notice": "The same claimed recording has inconsistent metadata or duration",
                    },
                    "observed_conflict",
                )
    for key, tracks in sorted(metadata.items()):
        ordered = sorted(tracks, key=lambda track: (track.duration_ms, track.id))
        groups = []
        for track in ordered:
            if not groups or track.duration_ms - groups[-1][0].duration_ms > 2000:
                groups.append([])
            groups[-1].append(track)
        for group in groups:
            if len(group) < 2:
                continue
            if len({track.sha256 for track in group}) == 1 and group[0].sha256:
                continue
            add(
                "possible_metadata_duplicate",
                group,
                {
                    "normalized_title": key[0],
                    "normalized_artist": key[1],
                    "normalized_album": key[2],
                    "duration_range_ms": [
                        group[0].duration_ms,
                        group[-1].duration_ms,
                    ],
                    "notice": "Metadata similarity is not proof of duplicate audio",
                },
                "metadata_only",
            )
    counts = dict(sorted(Counter(finding["code"] for finding in findings).items()))
    # Reviewable issues first; deterministic order makes repeated reports comparable.
    findings.sort(
        key=lambda finding: (
            finding["severity"] == "info",
            finding["code"],
            finding["track_ids"],
        )
    )
    return {
        "version": VERSION,
        "tracks_scanned": len(manifest.tracks),
        "catalog_reconciled": matches is not None,
        "catalog_matchable": matchable,
        "findings_total": len(findings),
        "findings_by_code": counts,
        "findings": findings[: manifest.max_findings],
        "findings_truncated": len(findings) > manifest.max_findings,
        "files_read": False,
        "files_modified": False,
        "automatic_actions": [],
        "scope": "Submitted metadata manifest only; no audio fingerprints or filesystem scan",
    }
