import pytest

from backend.core.problems import APIError
from backend.services.validation import (
    normalize_tags,
    validate_custom_alias,
    validate_long_url,
)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://example.com/path?q=1#f", "https://example.com/path?q=1#f"),
        ("HTTPS://Example.COM/Path", "https://example.com/Path"),
        ("http://example.com", "http://example.com/"),
        ("https://example.com:8443/x", "https://example.com:8443/x"),
        ("https://例え.jp/x", "https://xn--r8jz45g.jp/x"),
    ],
)
def test_valid_urls(url: str, expected: str) -> None:
    assert validate_long_url(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/x",
        "javascript:alert(1)",
        "https://user:pass@example.com/",
        "https://localhost/x",
        "https://foo.localhost/x",
        "https://printer.local/x",
        "https://service.internal/x",
        "http://127.0.0.1/x",
        "http://10.0.0.1/x",
        "http://192.168.1.1/x",
        "http://169.254.169.254/latest/meta-data",
        "https://example.com/a b",
        " https://example.com/x",
        "https://example.com/x\\y",
        "https://example.com/\n",
        "https://example.com/" + "a" * 8192,
    ],
)
def test_invalid_urls(url: str) -> None:
    with pytest.raises(APIError) as exc:
        validate_long_url(url)
    assert exc.value.status == 400


@pytest.mark.parametrize("alias", ["abc", "my-link_2", "a1b"])
def test_valid_aliases(alias: str) -> None:
    assert validate_custom_alias(alias) == alias


@pytest.mark.parametrize("alias", ["ab", "Aaa", "-abc", "abc-", "a" * 33, "health", "api", "docs"])
def test_invalid_aliases(alias: str) -> None:
    with pytest.raises(APIError):
        validate_custom_alias(alias)


def test_tags_are_normalized_deduplicated_and_ordered() -> None:
    assert normalize_tags(["  Marketing Team ", "#launch", "marketing-team"]) == [
        "marketing-team",
        "launch",
    ]
    assert normalize_tags(["-lead-", "two__words"]) == ["lead", "two-words"]
    assert normalize_tags(None) == []


@pytest.mark.parametrize(
    "tags",
    [
        [""],
        ["---"],
        ["a" * 25],
        ["ok", "one", "two", "three", "four", "five"],
    ],
)
def test_invalid_tags_are_rejected(tags: list[str]) -> None:
    with pytest.raises(APIError) as caught:
        normalize_tags(tags)
    assert caught.value.status == 422


def test_blocked_hosts_match_subdomains() -> None:
    with pytest.raises(APIError) as caught:
        validate_long_url(
            "https://links.spam.example/x",
            blocked_hosts=["spam.example"],
        )
    assert caught.value.code == "url_blocked"


def test_short_host_is_always_blocked() -> None:
    with pytest.raises(APIError) as caught:
        validate_long_url(
            "https://shortly.example/abc",
            short_host="shortly.example",
        )
    assert caught.value.code == "url_blocked"


def test_unrelated_host_passes_blocklist() -> None:
    assert (
        validate_long_url(
            "https://example.com/x",
            blocked_hosts=["spam.example"],
            short_host="shortly.example",
        )
        == "https://example.com/x"
    )
