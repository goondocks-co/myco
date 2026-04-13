# Myco Collective Workspace Layout

This branch restructures Myco into a workspace layout with three package surfaces:

- `packages/myco` — local CLI, daemon, hooks, MCP server, dashboard UI
- `packages/myco-team` — team sync worker package and deployment CLI surface
- `packages/myco-collective` — Collective worker package and deployment CLI surface

The repo root is the workspace orchestration layer only. Source, UI, worker, and publishable assets now live under their owning packages rather than mirrored root paths.

## Commands

The root build now verifies the workspace layout:

```sh
make check
make build
```

Package-local builds:

```sh
npm run build -w @goondocks/myco
npm run build -w @goondocks/myco-team
npm run build -w @goondocks/myco-collective
```

Release tags are package-scoped:

- `myco/vX.Y.Z`
- `myco-team/vX.Y.Z`
- `myco-collective/vX.Y.Z`

Each tag triggers build, release, and npm publish for that package only.

## Validation

Local validation for this branch is:

```sh
make check
make build
```

Live Cloudflare validation is scripted in:

```sh
node scripts/collective-cloudflare-smoke.mjs
```

That smoke run provisions a team worker and a Collective worker, verifies worker health and the hosted admin SPA, registers a project, confirms heartbeat/status propagation, rotates the Collective admin token, and then destroys the temporary Cloudflare resources.

## Team Worker

`packages/myco-team` now owns the team worker source previously embedded under `src/worker/`, including its standalone deployment CLI surface.

New team-worker Collective routes:

- `POST /collective/configure`
- `GET /collective/settings`
- `GET /collective/status`
- `POST /collective/query`

## Collective Worker

`packages/myco-collective/worker` provides the initial Collective backend:

- D1 schema for `projects`, `settings_overrides`, and `collective_meta`
- admin API routes under `/api/*`
- MCP routes under `/mcp/*`
- fan-out search/query handling across registered team workers

The initial CLI surface in `packages/myco-collective/src` supports:

- `myco-collective install`
- `myco-collective upgrade`
- `myco-collective status`
- `myco-collective rotate-tokens`
- `myco-collective add-project`
- `myco-collective destroy`

Deployment now stages a dedicated bundle under `~/.myco-collective/deployments/<worker-name>/` so worker config and built UI assets are deployed from an isolated artifact instead of mutating tracked package templates in place.

## Local Myco Integration

The local daemon now proxies Collective access through the connected team worker:

- `/api/collective/status`
- `/api/collective/search`
- `/api/collective/projects`
- `/api/collective/project`
- `/api/collective/settings`

Local MCP exposes these tools only when team status reports a connected Collective:

- `collective_search`
- `collective_projects`
- `collective_project`

## Worker-hosted UI

`packages/myco-collective/worker` serves the built admin SPA using Cloudflare static assets. API, MCP, and health routes run the Worker first; all other routes fall through to the packaged UI with SPA-style not-found handling.

Both the team worker and the Collective worker include Cloudflare's `global_fetch_strictly_public` compatibility flag. The v1 design depends on same-account Worker-to-Worker fetches over `workers.dev` during project registration, settings sync, heartbeat updates, and Collective query fan-out, and Cloudflare returns error `1042` without that flag.
