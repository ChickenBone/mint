import httpx
import pytest
from fastapi.testclient import TestClient

from auditor.api import create_app
from auditor.catalog import validate_url


def payload(**extra):
    return {
        "tracks": [{"id": "fixture-1", "title": "Northern Lights", "artist": "Example Artist"}],
        **extra,
    }


def result(status="candidates"):
    return {
        "version": "recording-reconciliation-v1",
        "status": status,
        "candidates": [
            {
                "key": "deezer:global:song:123",
                "match_type": "metadata_candidate",
                "evidence": [{"code": "title_exact"}],
                "conflicts": [],
            }
        ]
        if status != "no_match"
        else [],
        "automatic_merge": False,
    }


def test_offline_audit_and_configured_state():
    with TestClient(create_app(catalog_url="")) as client:
        response = client.post("/v1/audits", json=payload())
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert not response.json()["catalog_reconciled"]
        assert not client.get("/healthz").json()["catalog_configured"]
        assert client.post("/v1/audits", json=payload(reconcile=True)).status_code == 503
        assert client.get("/healthz", headers={"Host": "evil.example"}).status_code == 400


def test_catalog_connection_is_read_only_explicit_and_provenance_preserving():
    requests = []

    def handle(request):
        requests.append(request)
        assert request.method == "POST"
        assert request.url.path == "/v1/reconcile/recordings"
        assert request.headers["Host"] == "localhost"
        return httpx.Response(200, json=result())

    with TestClient(
        create_app(
            "http://catalog:8080",
            transport=httpx.MockTransport(handle),
        )
    ) as client:
        assert client.post("/v1/audits", json=payload()).status_code == 200
        assert not requests
        response = client.post("/v1/audits", json=payload(reconcile=True))
        assert response.status_code == 200
        report = response.json()
        assert report["catalog_reconciled"] and len(requests) == 1
        issue = next(f for f in report["findings"] if f["code"] == "catalog_match_review")
        assert issue["evidence"] == result()


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503),
        httpx.Response(302, headers={"Location": "http://other.example"}),
        httpx.Response(200, json={"results": []}),
        httpx.Response(
            200,
            json={
                "version": "recording-reconciliation-v1",
                "status": "identified",
                "candidates": [],
                "automatic_merge": False,
            },
        ),
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, content=b"x" * 262145),
    ],
)
def test_catalog_failure_never_becomes_a_successful_empty_audit(response):
    with TestClient(
        create_app(
            "http://catalog:8080",
            transport=httpx.MockTransport(lambda request: response),
        )
    ) as client:
        assert client.post("/v1/audits", json=payload(reconcile=True)).status_code == 502


def test_body_limit_works_for_chunked_requests():
    with TestClient(create_app(catalog_url="")) as client:
        response = client.post(
            "/v1/audits",
            content=iter([b" " * (4 * 1024**2)] * 3),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 413
        assert client.post("/v1/audits", json={"tracks": []}).status_code == 422


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://user:pass@localhost",
        "http://localhost/api",
        "http://localhost?token=secret",
        "http://localhost#fragment",
    ],
)
def test_catalog_origin_is_configuration_not_untrusted_manifest_input(url):
    with pytest.raises(ValueError):
        validate_url(url)
