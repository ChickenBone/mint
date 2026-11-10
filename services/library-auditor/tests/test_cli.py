import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).parents[1]


def run(path, *args):
    return subprocess.run(
        [sys.executable, "-m", "auditor.main", "audit", str(path), *args],
        cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(ROOT), "CATALOG_URL": ""},
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_cli_produces_persistable_report_without_modifying_input(tmp_path):
    path = tmp_path / "manifest.json"
    original = b'{"tracks":[{"id":"fixture"}]}'
    path.write_bytes(original)
    result = run(path)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["tracks_scanned"] == 1
    assert report["findings_by_code"] == {"metadata_gaps": 1}
    assert path.read_bytes() == original
    output = tmp_path / "report.json"
    output.write_text(result.stdout)
    assert json.loads(output.read_text()) == report


def test_cli_failure_has_nonzero_exit_and_no_success_report(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text('{"tracks":[]}')
    result = run(path)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "Audit failed" in result.stderr
    path.write_text('{"tracks":[{"id":"fixture"}],"reconcile":true}')
    result = run(path)
    assert result.returncode == 1
    assert "Supply --catalog-url" in result.stderr
