import hashlib
from threading import Event

import httpx
import pytest

from catalog.snapshot import download, small_text, verified


def test_snapshot_download_is_atomic_checksummed_and_resumable(tmp_path):
    data = b"official-fixture-bytes"
    checksum = hashlib.sha256(data).hexdigest()
    path = tmp_path / "artist.tar.xz"
    partial = path.with_name(path.name + ".part")
    partial.write_bytes(data[:7])
    requests = []

    def handle(request):
        requests.append(request)
        assert request.headers["Range"] == "bytes=7-"
        return httpx.Response(
            206,
            content=data[7:],
            headers={
                "Content-Range": f"bytes 7-{len(data) - 1}/{len(data)}",
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert download(client, "https://data.metabrainz.org/fixture", path, checksum)
        assert path.read_bytes() == data and not partial.exists()
        assert download(client, "https://data.metabrainz.org/fixture", path, checksum)
        assert len(requests) == 1


def test_checksum_mismatch_never_publishes_file(tmp_path):
    path = tmp_path / "artist.tar.xz"
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"wrong"))
    ) as client:
        with pytest.raises(ValueError, match="SHA-256"):
            download(client, "https://data.metabrainz.org/fixture", path, "0" * 64)
    assert not path.exists()
    assert path.with_name(path.name + ".part").read_bytes() == b"wrong"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"ignored range"),
        httpx.Response(206, content=b"wrong range", headers={"Content-Range": "bytes 0-5/6"}),
    ],
)
def test_resume_cannot_append_full_or_wrong_range_response(tmp_path, response):
    path = tmp_path / "release.tar.xz"
    partial = path.with_name(path.name + ".part")
    partial.write_bytes(b"partial")
    with httpx.Client(transport=httpx.MockTransport(lambda request: response)) as client:
        with pytest.raises(ValueError, match="resume|byte range"):
            download(client, "https://data.metabrainz.org/fixture", path, "0" * 64)
    assert partial.read_bytes() == b"partial"


def test_manifest_body_is_bounded():
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 65537))
    ) as client:
        with pytest.raises(ValueError, match="64 KiB"):
            small_text(client, "https://data.metabrainz.org/fixture")


def test_download_stop_retains_partial_without_publishing(tmp_path):
    stop = Event()
    stop.set()
    path = tmp_path / "artist.tar.xz"
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"fixture"))
    ) as client:
        assert not download(client, "https://data.metabrainz.org/fixture", path, "0" * 64, stop)
    assert not path.exists()
    with pytest.raises(ValueError, match="SHA-256"):
        verified(path.with_name(path.name + ".part"), "0" * 64)
