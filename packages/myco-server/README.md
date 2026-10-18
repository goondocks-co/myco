# Myco server

Private workspace package for Myco's 2.0 server. It owns event processing, sessions, spores, plans, the code map, settings, remote MCP and the queue for agent work. Registered runners execute that work; starting a server or signing a member in does not start a runner.

For operating a server, use [Run your own Myco](../../docs/self-hosting.md). For the dashboard, see [The dashboard](../../docs/dashboard.md) and [Configuration](../../docs/configuration.md). This package's development and deployment scripts are contributor tools, not the supported provisioning workflow.

## Layout

| Path | Owns |
|---|---|
| `src/core/` | Domain operations, settings, jobs and task dispatch. |
| `src/mcp/` | Member, access-key and run-scoped tool surfaces. |
| `src/read/` | Read models used by the server's surfaces. |
| `src/` target adapters | Cloudflare and native server entry points and storage adapters. |
| `ui/` | The user dashboard and its navigation and settings catalogue. |
| `../../tests/myco-server/` | Server contracts, alongside target parity tests in the root test tree. |

Read the [2.0 architecture](../../docs/architecture/myco-2.0.md) and [Actors & boundaries](../../docs/architecture/actors-and-boundaries.md) before changing ownership or adding a surface. Run tools are bounded by each task's allowlist; member tools do not administer Myco. Settings have one writer, and UI, CLI and MCP operations share their underlying implementation.

## Local checks

From the repository root:

```bash
make install
npm run check:workers
npm run check:ui -w @goondocks/myco-server
npm run build:ui -w @goondocks/myco-server
npm test -- tests/myco-server/
```

Use isolated homes and disposable data for runtime tests. Never point test tooling at a real server's volume or operator record. [CONTRIBUTING.md](../../CONTRIBUTING.md) covers the full build, dogfooding and release checks.
