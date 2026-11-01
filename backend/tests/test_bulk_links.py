"""Bulk link actions against SQLite: scope, statuses, tags, roles and caches."""

import uuid
from itertools import count

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from backend.api import deps
from backend.api.routes import links as links_routes
from backend.core.problems import APIError
from backend.main import app
from backend.models import Url, UrlTag, User, Workspace
from backend.services import links as links_service

_ids = count(1)


async def _workspace(session, name: str) -> Workspace:
    workspace = Workspace(name=name, is_personal=False)
    session.add(workspace)
    await session.commit()
    return workspace


async def _link(session, workspace: Workspace, code: str, tags: list[str] = ()) -> Url:
    url = Url(
        id=next(_ids),
        short_code=code,
        long_url=f"https://example.com/{code}",
        workspace_id=workspace.id,
    )
    session.add(url)
    await session.flush()
    for tag in tags:
        session.add(UrlTag(url_id=url.id, tag=tag))
    await session.commit()
    return url


async def _tags(session, code: str) -> list[str]:
    result = await session.execute(
        select(UrlTag.tag).join(Url, Url.id == UrlTag.url_id).where(Url.short_code == code)
    )
    return sorted(result.scalars().all())


@pytest.mark.asyncio
async def test_pause_resume_and_delete_only_touch_this_workspace(factory) -> None:
    async with factory() as session:
        mine = await _workspace(session, "Mine")
        other = await _workspace(session, "Other")
        await _link(session, mine, "alpha")
        await _link(session, mine, "beta")
        await _link(session, other, "gamma")

        paused = await links_service.bulk_update(
            session, mine.id, ["alpha", "gamma", "beta", "alpha", "nope"], "pause"
        )
        assert paused == [
            {"short_code": "alpha", "status": "ok"},
            {"short_code": "gamma", "status": "not_found"},
            {"short_code": "beta", "status": "ok"},
            {"short_code": "nope", "status": "not_found"},
        ]
        rows = {u.short_code: u for u in (await session.execute(select(Url))).scalars()}
        for row in rows.values():
            await session.refresh(row)
        assert rows["alpha"].is_active is False and rows["beta"].is_active is False
        assert rows["gamma"].is_active is True

        await links_service.bulk_update(session, mine.id, ["alpha"], "resume")
        await session.refresh(rows["alpha"])
        assert rows["alpha"].is_active is True

        await links_service.bulk_update(session, mine.id, ["beta"], "delete")
        await session.refresh(rows["beta"])
        assert rows["beta"].deleted_at is not None
        again = await links_service.bulk_update(session, mine.id, ["beta"], "pause")
        assert again == [{"short_code": "beta", "status": "not_found"}]


@pytest.mark.asyncio
async def test_adding_tags_respects_the_per_link_limit(factory) -> None:
    async with factory() as session:
        mine = await _workspace(session, "Mine")
        await _link(session, mine, "roomy", ["spring"])
        await _link(session, mine, "full", ["a1", "a2", "a3", "a4", "a5"])
        await _link(session, mine, "almost", ["b1", "b2", "b3", "b4"])

        results = await links_service.bulk_update(
            session, mine.id, ["roomy", "full", "almost"], "add_tags", ["Spring", "launch"]
        )
        assert [item["status"] for item in results] == ["ok", "too_many_tags", "too_many_tags"]
        assert await _tags(session, "roomy") == ["launch", "spring"]
        assert await _tags(session, "full") == ["a1", "a2", "a3", "a4", "a5"]
        assert await _tags(session, "almost") == ["b1", "b2", "b3", "b4"]

        # A tag the link already has does not count against the limit.
        results = await links_service.bulk_update(session, mine.id, ["full"], "add_tags", ["a1"])
        assert results == [{"short_code": "full", "status": "ok"}]


@pytest.mark.asyncio
async def test_removing_tags(factory) -> None:
    async with factory() as session:
        mine = await _workspace(session, "Mine")
        await _link(session, mine, "one", ["launch", "spring"])
        await _link(session, mine, "two", ["spring"])

        await links_service.bulk_update(session, mine.id, ["one", "two"], "remove_tags", ["spring"])
        assert await _tags(session, "one") == ["launch"]
        assert await _tags(session, "two") == []


@pytest.mark.asyncio
async def test_tag_arguments_are_validated(factory) -> None:
    async with factory() as session:
        mine = await _workspace(session, "Mine")
        with pytest.raises(APIError) as missing:
            await links_service.bulk_update(session, mine.id, ["x1"], "add_tags", [])
        assert missing.value.errors[0]["field"] == "tags"
        with pytest.raises(APIError):
            await links_service.bulk_update(session, mine.id, ["x1"], "pause", ["spring"])
        with pytest.raises(APIError):
            await links_service.bulk_update(
                session, mine.id, ["x1"], "add_tags", ["t1", "t2", "t3", "t4", "t5", "t6"]
            )


@pytest.fixture
def api(factory, monkeypatch: pytest.MonkeyPatch):
    state: dict = {"role": "member", "evicted": [], "workspace": None}

    async def session_override():
        async with factory() as session:
            yield session

    async def context_override():
        user = User(id=uuid.uuid4(), email="qa@example.com", password_hash="x", display_name="QA")
        return deps.WorkspaceContext(workspace=state["workspace"], role=state["role"], user=user)

    async def allow(*_args, **_kwargs):
        return True, 0

    async def evict(codes):
        state["evicted"].append(list(codes))

    monkeypatch.setattr(links_routes.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(links_routes, "invalidate_caches", evict)
    app.dependency_overrides[deps.get_api_session] = session_override
    app.dependency_overrides[deps.get_workspace_context] = context_override
    yield state
    app.dependency_overrides.pop(deps.get_api_session, None)
    app.dependency_overrides.pop(deps.get_workspace_context, None)


async def _post(body: dict, **headers: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/api/v1/links/bulk", json=body, headers=headers)


@pytest.mark.asyncio
async def test_bulk_route_evicts_changed_links_from_the_cache(factory, api) -> None:
    async with factory() as session:
        api["workspace"] = await _workspace(session, "Mine")
        await _link(session, api["workspace"], "alpha")

    response = await _post({"codes": ["alpha", "ghost"], "action": "pause"})

    assert response.status_code == 200
    body = response.json()
    assert body["updated"] == 1
    assert body["results"][1] == {"short_code": "ghost", "status": "not_found"}
    assert api["evicted"] == [["alpha"]]

    tagged = await _post({"codes": ["alpha"], "action": "add_tags", "tags": ["launch"]})
    assert tagged.status_code == 200
    assert api["evicted"] == [["alpha"]]


@pytest.mark.asyncio
async def test_viewers_cannot_use_bulk_actions(factory, api) -> None:
    async with factory() as session:
        api["workspace"] = await _workspace(session, "Mine")
    api["role"] = "viewer"

    response = await _post({"codes": ["alpha"], "action": "delete"})

    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"


@pytest.mark.asyncio
async def test_bulk_requests_are_bounded(factory, api) -> None:
    async with factory() as session:
        api["workspace"] = await _workspace(session, "Mine")

    too_many = await _post({"codes": [f"c{i:03d}" for i in range(201)], "action": "pause"})
    empty = await _post({"codes": [], "action": "pause"})
    unknown = await _post({"codes": ["alpha"], "action": "archive"})

    assert too_many.status_code == empty.status_code == unknown.status_code == 422


@pytest.mark.asyncio
async def test_cross_site_bulk_requests_are_rejected(factory, api) -> None:
    async with factory() as session:
        api["workspace"] = await _workspace(session, "Mine")

    response = await _post({"codes": ["alpha"], "action": "delete"}, origin="https://evil.example")

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_rejected"
