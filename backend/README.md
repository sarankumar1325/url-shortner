# URL Shortener API

FastAPI service for the URL shortener, managed with [uv](https://docs.astral.sh/uv/).

## Requirements

- Python 3.12+
- uv

## Setup

```bash
uv sync
cp .env.example .env
```

## Run locally

```bash
uv run uvicorn backend.main:app --reload
```

- API docs: <http://127.0.0.1:8000/docs>
- Health probe: <http://127.0.0.1:8000/health>

## Test and lint

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Design

The API contract, data model, caching, analytics, security, and Vercel deployment are documented in [`../docs/backend/`](../docs/backend/). The current code is the initial foundation: app factory, settings, CORS, `/health`, tests, and the Vercel entrypoint.

Deployment target: Vercel with the `backend` root directory, `uv.lock`, and `backend.main:app` as the entrypoint.
