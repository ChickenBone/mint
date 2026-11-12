import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.config import LOOPBACK_HOSTS, MAX_EXTRA_HOSTS, allowed_hosts


def configured(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("ALLOWED_HOSTS", raising=False)
    else:
        monkeypatch.setenv("ALLOWED_HOSTS", value)
    return allowed_hosts()


def test_only_loopback_names_are_allowed_by_default(monkeypatch):
    assert configured(monkeypatch, None) == list(LOOPBACK_HOSTS)
    assert configured(monkeypatch, " , ") == list(LOOPBACK_HOSTS)


def test_private_service_names_are_normalised_and_deduplicated(monkeypatch):
    assert configured(monkeypatch, " Catalog-Search , ,catalog-search,10.1.2.3,my_catalog ") == [
        *LOOPBACK_HOSTS,
        "catalog-search",
        "10.1.2.3",
        "my_catalog",
    ]
    assert configured(monkeypatch, "localhost") == list(LOOPBACK_HOSTS)


@pytest.mark.parametrize(
    "value",
    ["*", "*.example.com", "http://catalog", "catalog/search", "catalog:8080", "a..b", "-catalog", "catalog-", "cata log"],
)
def test_wildcards_and_non_host_values_are_rejected(monkeypatch, value):
    with pytest.raises(ValueError, match="ALLOWED_HOSTS"):
        configured(monkeypatch, value)


def test_the_number_of_added_names_is_bounded(monkeypatch):
    names = [f"service-{number}" for number in range(MAX_EXTRA_HOSTS)]
    assert configured(monkeypatch, ",".join(names)) == [*LOOPBACK_HOSTS, *names]
    with pytest.raises(ValueError, match=f"at most {MAX_EXTRA_HOSTS}"):
        configured(monkeypatch, ",".join([*names, "one-more"]))


def status(app, host):
    return TestClient(app, base_url=f"http://{host}").get("/healthz").status_code


def test_the_api_answers_only_to_allowed_host_headers(monkeypatch):
    # Without entering the client context the lifespan never runs, so no database or vector store is needed.
    monkeypatch.delenv("ALLOWED_HOSTS", raising=False)
    default = create_app()
    assert [status(default, host) for host in ("localhost", "127.0.0.1:8097", "catalog-search:8080")] == [200, 200, 400]

    monkeypatch.setenv("ALLOWED_HOSTS", "catalog-search")
    app = create_app()
    assert status(app, "catalog-search:8080") == 200
    assert status(app, "127.0.0.1:8097") == 200
    assert status(app, "other-service:8080") == 400
    assert status(app, "evil.example") == 400
