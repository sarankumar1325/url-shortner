import pytest

from backend.core.problems import APIError
from backend.models import AbuseReport
from backend.services import abuse as abuse_service


class _Result:
    def __init__(self, value) -> None:
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _Session:
    def __init__(self, url_id: int | None = 42) -> None:
        self._url_id = url_id
        self.added: list[AbuseReport] = []
        self.committed = False

    async def execute(self, statement):
        return _Result(self._url_id)

    def add(self, instance) -> None:
        self.added.append(instance)

    async def commit(self) -> None:
        self.committed = True


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("abc123", "abc123"),
        ("  abc123  ", "abc123"),
        ("https://shortlygo.vercel.app/abc123", "abc123"),
        ("shortlygo.vercel.app/abc123/", "abc123"),
    ],
)
def test_short_code_accepts_codes_and_links(raw: str, expected: str) -> None:
    assert abuse_service.normalize_short_code(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "bad code", "a" * 33, "abc?x=1"])
def test_short_code_rejects_invalid_values(raw: str) -> None:
    with pytest.raises(APIError) as caught:
        abuse_service.normalize_short_code(raw)
    assert caught.value.status == 422


def test_details_and_email_are_trimmed() -> None:
    assert abuse_service.normalize_details("  phishing page  ") == "phishing page"
    assert abuse_service.normalize_details("   ") is None
    assert abuse_service.normalize_email(" Person@Example.COM ") == "person@example.com"


@pytest.mark.parametrize(
    "details,email",
    [("x" * 2001, None), (None, "not-an-email"), (None, "two@example.com@x")],
)
def test_invalid_report_fields_are_rejected(details, email) -> None:
    with pytest.raises(APIError):
        abuse_service.normalize_details(details)
        if email:
            abuse_service.normalize_email(email)


@pytest.mark.asyncio
async def test_create_report_links_existing_code_and_commits() -> None:
    session = _Session(url_id=42)

    result = await abuse_service.create_report(
        session,
        short_code="https://shortly.example/abc123",
        reason="phishing",
        details="Fake login page.",
        reporter_email=" Person@Example.com ",
    )

    assert session.committed
    report = session.added[0]
    assert report.short_code == "abc123"
    assert report.url_id == 42
    assert report.reason == "phishing"
    assert report.reporter_email == "person@example.com"
    assert report.status == "open"
    assert result["status"] == "open"
    assert result["created_at"].endswith("Z")


@pytest.mark.asyncio
async def test_unknown_code_is_still_accepted() -> None:
    session = _Session(url_id=None)
    result = await abuse_service.create_report(
        session,
        short_code="missing",
        reason="spam",
        details=None,
        reporter_email=None,
    )
    assert session.added[0].url_id is None
    assert result["short_code"] == "missing"


@pytest.mark.asyncio
async def test_invalid_reason_is_rejected_before_storage() -> None:
    session = _Session()
    with pytest.raises(APIError) as caught:
        await abuse_service.create_report(
            session,
            short_code="abc123",
            reason="rude",
            details=None,
            reporter_email=None,
        )
    assert caught.value.status == 422
    assert not session.added
    assert not session.committed
