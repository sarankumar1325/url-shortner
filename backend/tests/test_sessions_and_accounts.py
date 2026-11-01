"""Sessions, password rehashing, account deletion and retired codes against SQLite.

The schema is the real one minus Postgres-only CHECK constraints, so the
combined session query, cascades and deletion rules run as actual SQL.
"""

import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from argon2 import PasswordHasher
from sqlalchemy import select

from backend.core import timing
from backend.core.problems import APIError
from backend.core.security import hash_opaque_token, password_needs_rehash, verify_password
from backend.models import (
    RetiredShortCode,
    Url,
    User,
    UserSession,
    Workspace,
    WorkspaceMember,
)
from backend.scripts.delete_accounts import check_pattern
from backend.services import accounts
from backend.services import auth as auth_service
from backend.services import links as links_service
from backend.services import workspaces as workspace_service

PASSWORD = "correct-horse-battery"


async def _signup(session, email: str, *, persistent: bool = True) -> tuple[User, str]:
    return await auth_service.signup(
        session, email=email, password=PASSWORD, display_name=None, persistent=persistent
    )


async def _shared(session, owner: User, name: str, *members: User) -> Workspace:
    workspace = Workspace(name=name, is_personal=False)
    session.add(workspace)
    await session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=owner.id, role="owner"))
    for member in members:
        session.add(WorkspaceMember(workspace_id=workspace.id, user_id=member.id, role="member"))
    await session.commit()
    return workspace


_next_url_id = iter(range(1, 10_000))


async def _link(session, workspace: Workspace, code: str, creator: User | None = None) -> None:
    session.add(
        Url(
            id=next(_next_url_id),
            short_code=code,
            long_url="https://example.com/",
            workspace_id=workspace.id,
            created_by_user_id=creator.id if creator else None,
        )
    )
    await session.commit()


async def _personal(session, user: User) -> Workspace:
    result = await session.execute(select(Workspace).where(Workspace.personal_user_id == user.id))
    return result.scalar_one()


@pytest.mark.asyncio
async def test_session_context_reads_session_user_and_role_in_one_query(factory) -> None:
    async with factory() as session:
        user, token = await _signup(session, "one@example.com")
        other, _ = await _signup(session, "two@example.com")
        shared = await _shared(session, other, "Team", user)
        foreign = await _shared(session, other, "Private")

        timings, reset = timing.start()
        try:
            personal = await auth_service.session_context(session, token, with_workspace=True)
        finally:
            timing.stop(reset)
        assert timings.db_queries == 1
        assert personal.user.id == user.id
        assert personal.workspace.is_personal and personal.role == "owner"

        team = await auth_service.session_context(session, token, shared.id, with_workspace=True)
        assert team.workspace.id == shared.id and team.role == "member"

        outside = await auth_service.session_context(
            session, token, foreign.id, with_workspace=True
        )
        assert outside.user.id == user.id and outside.workspace is None

        assert await auth_service.session_context(session, "shrs_unknown") is None


@pytest.mark.asyncio
async def test_login_upgrades_hashes_made_with_the_old_parameters(factory) -> None:
    async with factory() as session:
        user, _ = await _signup(session, "legacy@example.com")
        legacy = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4).hash(PASSWORD)
        user.password_hash = legacy
        await session.commit()
        assert password_needs_rehash(legacy)

        await auth_service.login(session, email="legacy@example.com", password=PASSWORD)

        stored = (await session.execute(select(User.password_hash))).scalars().first()
        assert stored != legacy
        assert "m=19456,t=2,p=1" in stored
        assert not password_needs_rehash(stored)
        assert verify_password(PASSWORD, stored)


@pytest.mark.asyncio
async def test_current_hashes_are_left_alone_on_login(factory) -> None:
    async with factory() as session:
        user, _ = await _signup(session, "fresh@example.com")
        before = user.password_hash
        await auth_service.login(session, email="fresh@example.com", password=PASSWORD)
        await session.refresh(user)
        assert user.password_hash == before


def test_module_import_does_not_compute_the_dummy_hash() -> None:
    probe = "import backend.core.security as s; print(s._dummy_hash is None)"
    output = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    ).stdout
    assert output.strip() == "True"


@pytest.mark.asyncio
async def test_sessions_without_stay_signed_in_are_short_and_never_renewed(factory) -> None:
    async with factory() as session:
        _, token = await auth_service.login(
            session,
            email=(await _signup(session, "brief@example.com"))[0].email,
            password=PASSWORD,
            persistent=False,
        )
        row = await session.get(UserSession, hash_opaque_token(token))
        assert row.persistent is False
        lifetime = row.expires_at.replace(tzinfo=UTC) - datetime.now(UTC)
        assert timedelta(hours=23) < lifetime <= timedelta(hours=24)

        row.expires_at = datetime.now(UTC) + timedelta(minutes=5)
        await session.commit()
        context = await auth_service.session_context(session, token)
        assert context is not None and not context.renewed


@pytest.mark.asyncio
async def test_persistent_sessions_renew_once_past_half_their_lifetime(factory) -> None:
    async with factory() as session:
        _, token = await _signup(session, "stay@example.com")
        context = await auth_service.session_context(session, token)
        assert context.persistent and not context.renewed

        row = await session.get(UserSession, hash_opaque_token(token))
        row.expires_at = datetime.now(UTC) + timedelta(days=10)
        await session.commit()
        context = await auth_service.session_context(session, token)
        assert context.renewed
        await session.refresh(row)
        assert row.expires_at.replace(tzinfo=UTC) - datetime.now(UTC) > timedelta(days=29)


@pytest.mark.asyncio
async def test_expired_sessions_are_deleted(factory) -> None:
    async with factory() as session:
        _, token = await _signup(session, "old@example.com")
        row = await session.get(UserSession, hash_opaque_token(token))
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
        assert await auth_service.session_context(session, token) is None
        session.expunge_all()
        assert await session.get(UserSession, hash_opaque_token(token)) is None


@pytest.mark.asyncio
async def test_account_deletion_is_blocked_by_shared_workspaces_with_members(factory) -> None:
    async with factory() as session:
        owner, _ = await _signup(session, "owner@example.com")
        member, _ = await _signup(session, "member@example.com")
        team = await _shared(session, owner, "Team", member)

        with pytest.raises(APIError) as blocked:
            await accounts.delete_account(
                session, user=owner, password=PASSWORD, confirm_email="owner@example.com"
            )
        assert blocked.value.status == 409
        assert blocked.value.code == "owns_shared_workspaces"
        assert blocked.value.errors[0]["workspace_id"] == str(team.id)
        assert "1 other member." in blocked.value.errors[0]["message"]
        assert await session.get(User, owner.id) is not None


@pytest.mark.asyncio
async def test_account_deletion_checks_password_and_email(factory) -> None:
    async with factory() as session:
        user, _ = await _signup(session, "careful@example.com")
        with pytest.raises(APIError) as wrong_password:
            await accounts.delete_account(
                session, user=user, password="nope-nope-nope", confirm_email=user.email
            )
        assert wrong_password.value.code == "invalid_password"
        with pytest.raises(APIError) as wrong_email:
            await accounts.delete_account(
                session, user=user, password=PASSWORD, confirm_email="other@example.com"
            )
        assert wrong_email.value.code == "confirmation_mismatch"
        # Pasted emails with stray spaces or capitals still confirm.
        await accounts.delete_account(
            session, user=user, password=PASSWORD, confirm_email="  Careful@Example.com "
        )


@pytest.mark.asyncio
async def test_account_deletion_removes_owned_data_and_retires_codes(factory) -> None:
    async with factory() as session:
        user, token = await _signup(session, "leaving@example.com")
        friend, _ = await _signup(session, "friend@example.com")
        personal = await _personal(session, user)
        solo = await _shared(session, user, "Side project")
        friends_team = await _shared(session, friend, "Friends", user)
        await _link(session, personal, "aaaaa", user)
        await _link(session, solo, "solo-link", user)
        await _link(session, friends_team, "bbbbb", user)

        codes = await accounts.delete_account(
            session, user=user, password=PASSWORD, confirm_email=user.email
        )

        assert sorted(codes) == ["aaaaa", "solo-link"]
        session.expunge_all()
        assert await session.get(User, user.id) is None
        assert await session.get(Workspace, personal.id) is None
        assert await session.get(Workspace, solo.id) is None
        assert await session.get(UserSession, hash_opaque_token(token)) is None
        retired = (await session.execute(select(RetiredShortCode.short_code))).scalars().all()
        assert sorted(retired) == ["aaaaa", "solo-link"]
        kept = (await session.execute(select(Url).where(Url.short_code == "bbbbb"))).scalar_one()
        assert kept.workspace_id == friends_team.id
        assert kept.created_by_user_id is None
        members = await workspace_service.list_members(session, friends_team.id)
        assert [item["email"] for item in members] == ["friend@example.com"]


@pytest.mark.asyncio
async def test_workspace_deletion_retires_codes_and_alias_check_sees_them(
    factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def nothing_cached(*_args):
        return 0

    monkeypatch.setattr(links_service, "command", nothing_cached)
    async with factory() as session:
        owner, _ = await _signup(session, "studio@example.com")
        studio = await _shared(session, owner, "Studio")
        await _link(session, studio, "launch-day", owner)

        codes = await workspace_service.delete_workspace(
            session, workspace=studio, actor_id=owner.id, confirm_name="Studio"
        )

        assert codes == ["launch-day"]
        session.expunge_all()
        remaining = await session.execute(select(Url).where(Url.short_code == "launch-day"))
        assert remaining.first() is None
        availability = await links_service.alias_availability(session, "launch-day")
        assert availability["available"] is False
        assert availability["reason"] == "taken"
        fresh = await links_service.alias_availability(session, "brand-new")
        assert fresh["available"] is True


class _Returned:
    def __init__(self, value) -> None:
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _InsertSession:
    def __init__(self) -> None:
        self.codes: list[str] = []

    async def execute(self, statement):
        self.codes.append(statement.compile().params["short_code"])
        return _Returned(object())


@pytest.mark.asyncio
async def test_link_creation_skips_retired_random_codes(monkeypatch: pytest.MonkeyPatch) -> None:
    generated = iter(["Retir", "Fresh"])
    monkeypatch.setattr(links_service, "generate_short_code", lambda: next(generated))

    async def retired(_session, code: str) -> bool:
        return code == "Retir"

    monkeypatch.setattr(links_service, "is_retired", retired)
    session = _InsertSession()
    await links_service._insert_url(session, "https://example.com/", None, None, None, None, None)
    assert session.codes == ["Fresh"]


@pytest.mark.asyncio
async def test_retired_custom_aliases_are_taken(monkeypatch: pytest.MonkeyPatch) -> None:
    async def retired(_session, _code: str) -> bool:
        return True

    monkeypatch.setattr(links_service, "is_retired", retired)
    with pytest.raises(APIError) as taken:
        await links_service._insert_url(
            _InsertSession(), "https://example.com/", "old-alias", None, None, uuid.uuid4(), None
        )
    assert taken.value.code == "alias_taken"


def test_cleanup_script_refuses_broad_patterns() -> None:
    assert check_pattern("qa-droid-%@example.com") is None
    assert check_pattern("%@example.com") is not None
    assert check_pattern("q%") is not None
    assert check_pattern("qa-droid-%") is not None
