# Contributing to Myco

Myco captures coding sessions and serves project knowledge back to agents. In 2.0, a server owns the data, member machines capture and read, and explicitly registered runners do Myco's agent work. Read [AGENTS.md](AGENTS.md) for repository rules and the [2.0 architecture](docs/architecture/myco-2.0.md) before changing runtime ownership. [Actors & boundaries](docs/architecture/actors-and-boundaries.md) defines who each surface serves.

For installing and using Myco, start at [Join a Myco](docs/quickstart.md). This page is for working on the repository.

## Set up a checkout

Install Node and npm for the build tooling, and the Bun version pinned in [.bun-version](.bun-version) for the runtime and tests. CI's setup is in [.github/actions/ci-setup/action.yml](.github/actions/ci-setup/action.yml).

```bash
git clone https://github.com/goondocks-co/myco.git
cd myco
npm ci
```

The server dashboard and documentation site have their own dependencies. Install them when working on those surfaces:

```bash
npm ci --prefix packages/myco-server/ui
npm ci --prefix docs
```

Do not initialize a local vault to develop the 2.0 server. Keep test homes, credentials and databases separate from your real Myco installation. Tests that need a home should use disposable directories and the repository's isolation helpers; see [Test temporary directories](docs/development/test-temp-isolation.md).

## Repository layout

| Path | Owns |
|---|---|
| `packages/myco/` | Native member and runner CLI, capture hooks, agent integration, shipped skills and server operator commands. Retained 1.4 runtime code also lives here. |
| `packages/myco-server/src/` | The server: event processing, sessions, knowledge, settings, MCP and the task queue. |
| `packages/myco-server/ui/` | The user dashboard. |
| `packages/myco-shared/` | Contracts shared by the member, runner, server and dashboard. |
| `packages/myco-{darwin,linux,windows}-*/` | Platform binary distribution packages. |
| `plugins/myco/` | Generated plugin bundle; edit its sources under `packages/myco/skills/`. |
| `tests/` | Source tests, integration tests and architectural gates. |
| `docs/` | User site, architecture references and contributor material under `development/`. |

The server is authoritative for 2.0 session processing and knowledge. Hooks build events, append them to the member spool and deliver within their budget. They do not import the daemon or process sessions themselves. UI, CLI and MCP operations share underlying implementations; route shared-state writes through the capabilities in AGENTS.md.

## Check a change

Start with the smallest relevant tests:

```bash
npm test -- tests/member/
npm run lint
```

`npm test` is the canonical full test command. `make build` runs lint, the fast test profile and the distributable build; `make build-all` includes the full test sweep. Both also attempt a dogfood refresh in the main checkout. In a worktree that refresh is skipped. Use `make build-only` when you need artifacts without a dogfood refresh.

Before finishing a feature, run `make build` and smoke-test the changed behavior through the real command or runtime path. Use isolated homes for smoke tests. Do not install test services or connect test machines to real accounts.

For documentation changes:

```bash
npm run build --prefix docs
npm test --prefix docs
npm test -- tests/meta/
```

The docs CLI accuracy gate checks commands on published pages against the 2.0 CLI. Verify page labels and settings against the server dashboard's navigation and settings catalogue too. Every server command example must choose its target explicitly.

For shipped skill changes, regenerate the plugin bundle and both skill catalogues, then run their contracts:

```bash
npx tsx packages/myco/scripts/gen-plugin-bundle.ts
npm test -- tests/skills/
```

Generated files belong in the same commit as their sources. Skill trigger eval contracts check case structure and vocabulary; they do not prove a model will invoke a skill. See [Pull request checks](docs/development/ci.md) for the CI matrices and targeted shard commands.

## Dogfood deliberately

Development sessions are real project history. Preserve capture continuity and avoid destructive vault operations.

From the **main checkout**, `make dev-link` builds and installs the shared development binary. From a **Git worktree**, use `make dev-link-worktree`: it builds the worktree binary and writes a local runtime pin without replacing shared symlinks. See the `dogfood-worktree` skill before using it; worktrees can share capture storage, so schema changes need care.

Do not run `make dev-link` from a worktree. Prefer not to restart the shared daemon from a worktree. For retained hook or daemon changes, follow AGENTS.md's build and restart guidance. A member-only 2.0 machine has no capture daemon to restart.

## Pull requests and releases

Keep changes focused and explain the resulting behavior, the checks you ran and any validation limits. Add regression coverage when behavior changes. Keep comments about current behavior; put change history and decision rationale in the commit or PR description.

Release preparation and publication are separate. Prepare version and generated-plugin changes in a reviewed PR. The exact tagged commit must have green main CI and pass code-generation drift checks; verify the dry-run publication before publishing. Do not use a local successful build as evidence that a release is available. Members update on demand; runners update between runs.

Contributor references: [Release ordering](docs/development/release-ordering.md), [Plugin versions](docs/development/plugin-versioning-1709.md), [macOS signing](docs/development/macos-release-signing.md), [agent teams](docs/development/agent-teams.md), and the opt-in [worker smoke rig](docs/development/worker-smoke-rig.md).
