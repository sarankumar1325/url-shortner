# URL Shortener

A production-oriented URL shortener with a FastAPI backend and a React frontend, designed for two independent Vercel projects.

| Folder | Stack | Purpose |
| --- | --- | --- |
| [`backend/`](backend/README.md) | Python 3.12, FastAPI, uv | REST API and redirects |
| [`urlshortner/`](urlshortner/README.md) | Bun, Vite 8, React 19, TypeScript | Web app |
| [`docs/`](docs/README.md) | Markdown, Mermaid | Product, system design, API, data model, ADRs, deployment |

## Quick start

Backend:

```bash
cd backend
uv sync
cp .env.example .env
uv run uvicorn backend.main:app --reload
```

Frontend:

```bash
cd urlshortner
bun install
bun dev
```

- API health: <http://127.0.0.1:8000/health>
- Web app: <http://localhost:5173>

## Design baseline

V1 is anonymous but accounts-ready, backed by Neon Postgres and Upstash Redis, with asynchronous click analytics. See [docs/README.md](docs/README.md) for the scope, request flows, and reading order.

The current code is the initial scaffold; the design documents describe the target implementation.

## Verification

Run from the repository root; subshells keep each command in the correct folder.

```bash
(cd backend && uv run pytest && uv run ruff check . && uv run ruff format --check .)
(cd urlshortner && bun run lint && bun run build)
```

See the [phased implementation plan](docs/README.md#implementation-plan) for dependencies, acceptance tests, and production release gates. Hosting, persistence, and product features are not implemented by the scaffold.
