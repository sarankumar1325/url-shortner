import uuid
from datetime import UTC, datetime, timedelta

import pytest

from backend.core.problems import APIError
from backend.core.security import generate_password_hash, hash_opaque_token, verify_password
from backend.models import User as Account
from backend.models import UserSession, Workspace, WorkspaceMember
from backend.services import auth as auth_service
from backend.services import workspaces as workspace_service


class _Scalars:
    def __init__(self, rows) -> None:
        self._rows = rows

    def all(self):
        return self._rows


class _Result:
    def __init__(self, rows=None, rowcount: int = 0) -> None:
        self._rows = rows or []
        self.rowcount = rowcount

    def scalars(self) -> _Scalars:
        return _Scalars(self._rows)

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _Session:
    def __init__(self, results: list[_Result] | None = None) -> None:
        self._results = list(results or [])
        self.statements = []
        self.deleted = []
        self.committed = False

    async def execute(self, statement):
        self.statements.append(statement)
        return self._results.pop(0)

    async def delete(self, instance) -> None:
        self.deleted.append(instance)

    async def commit(self) -> None:
        self.committed = True


def _account(password: str = "correct-horse-battery") -> Account:
    return Account(
        id=uuid.uuid4(),
        email="person@example.com",
        display_name="Person",
        password_hash=generate_password_hash(password),
    )


@pytest.mark.asyncio
async def test_change_password_rejects_wrong_current_password() -> None:
    user = _account()
    session = _Session()

    with pytest.raises(APIError) as caught:
        await auth_service.change_password(
            session,
            user=user,
            current_password="not-the-password",
            new_password="another-good-password",
            current_token="shrs_current",
        )

    assert caught.value.status == 403
    assert caught.value.code == "invalid_password"
    assert not session.committed


@pytest.mark.asyncio
async def test_change_password_keeps_only_the_current_session() -> None:
    user = _account()
    session = _Session([_Result(rowcount=2)])

    await auth_service.change_password(
        session,
        user=user,
        current_password="correct-horse-battery",
        new_password="another-good-password",
        current_token="shrs_current",
    )

    assert verify_password("another-good-password", user.password_hash)
    assert not verify_password("correct-horse-battery", user.password_hash)
    assert session.committed
    statement = str(session.statements[0])
    assert "user_sessions.user_id =" in statement
    assert "user_sessions.token_hash !=" in statement


@pytest.mark.asyncio
async def test_change_password_rejects_reusing_the_same_password() -> None:
    user = _account()
    session = _Session()

    with pytest.raises(APIError) as caught:
        await auth_service.change_password(
            session,
            user=user,
            current_password="correct-horse-battery",
            new_password="correct-horse-battery",
            current_token="shrs_current",
        )

    assert caught.value.code == "validation_error"
    assert caught.value.errors[0]["field"] == "new_password"
    assert not session.committed


@pytest.mark.asyncio
async def test_list_sessions_marks_only_the_current_session() -> None:
    now = datetime.now(UTC)
    current_hash = hash_opaque_token("shrs_current")
    older = UserSession(
        token_hash=hash_opaque_token("shrs_older"),
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        created_at=now - timedelta(days=2),
        expires_at=now + timedelta(days=28),
    )
    current = UserSession(
        token_hash=current_hash,
        id=uuid.uuid4(),
        user_id=older.user_id,
        created_at=now,
        expires_at=now + timedelta(days=30),
    )
    session = _Session([_Result([current, older])])

    result = await auth_service.list_sessions(
        session, user=_account(), current_token="shrs_current"
    )

    assert [item["current"] for item in result] == [True, False]
    assert all(set(item) == {"id", "created_at", "expires_at", "current"} for item in result)
    assert all(item["expires_at"].endswith("Z") for item in result)


@pytest.mark.asyncio
async def test_revoke_session_is_scoped_to_the_account() -> None:
    session = _Session([_Result(rowcount=0)])
    with pytest.raises(APIError) as caught:
        await auth_service.revoke_session(session, user=_account(), session_id=uuid.uuid4())
    assert caught.value.status == 404
    assert caught.value.code == "session_not_found"

    session = _Session([_Result(rowcount=1)])
    await auth_service.revoke_session(session, user=_account(), session_id=uuid.uuid4())
    assert session.committed


@pytest.mark.asyncio
async def test_revoke_other_sessions_reports_count() -> None:
    session = _Session([_Result(rowcount=3)])

    revoked = await auth_service.revoke_other_sessions(
        session, user=_account(), current_token="shrs_current"
    )

    assert revoked == 3
    assert session.committed


def _workspace(*, personal: bool = False) -> Workspace:
    return Workspace(
        id=uuid.uuid4(),
        name="Studio",
        is_personal=personal,
        personal_user_id=None,
    )


def _member(workspace: Workspace, user_id: uuid.UUID, role: str) -> WorkspaceMember:
    return WorkspaceMember(workspace_id=workspace.id, user_id=user_id, role=role)


@pytest.mark.asyncio
async def test_rename_workspace_requires_admin_and_cleans_name() -> None:
    workspace = _workspace()
    session = _Session()

    await workspace_service.rename_workspace(
        session, workspace=workspace, actor_role="admin", name="  Design   Studio "
    )

    assert workspace.name == "Design Studio"
    assert session.committed

    with pytest.raises(APIError) as caught:
        await workspace_service.rename_workspace(
            session, workspace=workspace, actor_role="member", name="Nope"
        )
    assert caught.value.status == 403


@pytest.mark.asyncio
async def test_delete_workspace_requires_owner_and_matching_name() -> None:
    workspace = _workspace()
    owner_id = uuid.uuid4()
    actor = _member(workspace, owner_id, "owner")

    session = _Session([_Result([actor])])
    await workspace_service.delete_workspace(
        session, workspace=workspace, actor_id=owner_id, confirm_name=" Studio "
    )
    assert session.deleted == [workspace]
    assert session.committed

    with pytest.raises(APIError) as mismatch:
        await workspace_service.delete_workspace(
            _Session([_Result([actor])]),
            workspace=workspace,
            actor_id=owner_id,
            confirm_name="Other",
        )
    assert mismatch.value.code == "confirmation_mismatch"

    admin = _member(workspace, owner_id, "admin")
    with pytest.raises(APIError) as forbidden:
        await workspace_service.delete_workspace(
            _Session([_Result([admin])]),
            workspace=workspace,
            actor_id=owner_id,
            confirm_name="Studio",
        )
    assert forbidden.value.status == 403

    personal = _workspace(personal=True)
    with pytest.raises(APIError) as personal_error:
        await workspace_service.delete_workspace(
            _Session([_Result([_member(personal, owner_id, "owner")])]),
            workspace=personal,
            actor_id=owner_id,
            confirm_name="Studio",
        )
    assert personal_error.value.code == "personal_workspace"


@pytest.mark.asyncio
async def test_transfer_ownership_swaps_roles() -> None:
    workspace = _workspace()
    owner_id = uuid.uuid4()
    target_id = uuid.uuid4()
    owner = _member(workspace, owner_id, "owner")
    target = _member(workspace, target_id, "member")
    session = _Session([_Result([owner]), _Result([target])])

    await workspace_service.transfer_ownership(
        session, workspace=workspace, actor_id=owner_id, target_id=target_id
    )

    assert target.role == "owner"
    assert owner.role == "admin"
    assert session.committed

    with pytest.raises(APIError) as self_error:
        await workspace_service.transfer_ownership(
            _Session(), workspace=workspace, actor_id=owner_id, target_id=owner_id
        )
    assert self_error.value.code == "validation_error"

    fresh_owner = _member(workspace, owner_id, "owner")
    with pytest.raises(APIError) as missing:
        await workspace_service.transfer_ownership(
            _Session([_Result([fresh_owner]), _Result([])]),
            workspace=workspace,
            actor_id=owner_id,
            target_id=uuid.uuid4(),
        )
    assert missing.value.code == "member_not_found"
