# URL Shortener Web App

React single-page app for creating, managing, and understanding short links. Built with Bun, Vite, React, and TypeScript.

## Requirements

- Bun 1.4+
- Node.js 22.12+ (Vite requirement)

## Setup

```bash
bun install
cp .env.example .env.local
bun dev
```

The app runs at <http://localhost:5173>. The API must be running at `http://127.0.0.1:8000` for create and analytics flows.

## Scripts

```bash
bun dev        # development server
bun run build  # type-check and production build
bun preview    # serve the production build locally
bun run lint   # oxlint
```

## Environment

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | FastAPI base URL; the API's returned `short_url` is used for copying |

The value is public. Never put secrets in `VITE_*` variables.

## Design

The app implements the create, link-list, token-unlock, detail and analytics flows described in [../docs/frontend/architecture.md](../docs/frontend/architecture.md) and the related files in [`../docs/frontend/`](../docs/frontend/).
