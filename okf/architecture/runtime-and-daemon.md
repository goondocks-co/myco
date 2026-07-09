---
type: Architecture
title: Runtime & Daemon Authority
description: Why the background daemon, not Claude Code hooks, is the single authority for Myco's capture, storage, and scheduled intelligence work — and the home/power/database boundaries that make that authority safe.
timestamp: '2026-07-08T15:52:42.326Z'
---

Myco's intelligence work — capturing sessions, writing to the vault, running scheduled agent tasks like this OKF synthesis — is not done inside Claude Code's hook process. It is done by a long-running background **daemon**, one per machine home. Hooks exist only to notify the daemon that something happened; the daemon does everything else. This split is load-bearing: every other architecture and subsystem page in this bundle (see Session Capture Flow, [Vault Intelligence](/subsystems/vault-intelligence.md), Myco's Own Agent Harness) assumes the daemon is running, holds the database connections, and owns scheduling.

# Hooks are thin; the daemon is the authority

`packages/myco/src/hooks/*` (e.g. `post-tool-use.ts`, `pre-compact.ts`, `post-compact.ts`) are small dispatch scripts invoked by Claude Code's hook lifecycle. Their job is to validate a minimal payload and forward it to the daemon over HTTP — they do not touch SQLite, run miners, or make intelligence decisions themselves. `hooks/client.ts` is the piece that makes this reliable: it resolves the running daemon's PID/port/auth token from `daemon.json`, spawns or health-checks the daemon process if it isn't up, and attaches the daemon's bearer token (`x-myco-auth`) to every request. If the daemon is unreachable, hooks buffer events locally for later replay rather than doing capture work inline (see `tests/hooks/stop-buffer.test.ts`).

`packages/myco/src/daemon/main.ts` is the actual authority: it wires up event ingestion, session recording, Grove-scoped REST APIs, an in-process MCP HTTP server, and all scheduled project work, in one process per machine home. Everything downstream of a hook firing — the transcript miner, spore extraction, digest synthesis, skill materialization — runs inside this daemon, not inside the Claude Code process that triggered it.

# PowerManager and JobRunner: two responsibilities, deliberately split

`packages/myco/src/daemon/power.ts` defines a pure `PowerManager` state machine over four states — `active | idle | sleep | deep_sleep` — driven purely by elapsed time since `recordActivity()`. Its `PowerManagerConfig` takes an `onTick(state)` callback and a `deepSleepHolder()` predicate; **the manager itself never runs jobs** — that responsibility was deliberately extracted into `packages/myco/src/daemon/job-runner.ts`, which manages concurrent dispatch (housekeeping / drain / scheduler kinds), a concurrency cap, and event-loop-lag-aware scheduling.

This split (commit `29eced5d`, branch `feat/powermanager-runner`) replaced an earlier design where `PowerManager` both tracked state and ran jobs directly. The rearchitecture surfaced three transferable scheduling anti-patterns worth knowing before touching this code:

1. **Asymmetric slot reservation inverts.** An early fairness fix reserved a slot per pending drain so a long housekeeping job (e.g. release-provenance, 9–22 min) couldn't starve drains — but with 3 foreground jobs at a concurrency cap of 3, it starved *housekeeping* instead. The fix is symmetric two-lane fair sharing: neither the `background` (housekeeping) nor `foreground` (drain+scheduler) lane may hold more than `cap-1` slots when both have work, counted in-flight by lane across ticks.
2. **A per-slice deadline that restarts at index 0 starves the tail.** The embedding reconcile loop iterated `EMBEDDABLE_NAMESPACES` from the start on every slice; a slow provider meant early namespaces always consumed the 2s budget and later ones (like `canopy_entries`) never drained. Fixed with a persisted round-robin cursor.
3. **A deep-sleep hold must gate on whether the consumer will actually run.** The canopy pending-count hold originally counted pending rows unconditionally, which meant a default install (where `canopy-describe` ships `schedule.enabled: false`) would *never* deep-sleep, because `canopy-background-scan` keeps populating rows a disabled consumer never drains. The hold now only counts pending work for grove-tier-enabled tasks — a concrete instance of "count real backpressure, not raw queue depth" that the [Canopy](/subsystems/canopy.md) page's pending-count bug family also illustrates.

`packages/myco/src/daemon/grove-pending-probe.ts` factors the shared "walk all groves and count pending work" pattern that both the canopy hold and the embedding-drain hold need, caching both zero and non-zero results so a settled backlog doesn't force a full SQLite `COUNT` walk every tick.

# Grove SQLite: one database per project, owned by one daemon

Myco's persistent state is not one global database — it is a **Grove**: a per-project SQLite database rooted under a machine home. `packages/myco/src/grove/database.ts`'s `ensureGroveDatabase(groveId, mycoHome)` resolves the DB path via `resolveGroveDbPath`, creates the parent directory, opens the database, and runs `createSchema` (passing the real machine ID so historical `machine_id='local'` rows get converted). `packages/myco/src/daemon/grove-runtime-cache.ts` caches per-Grove SQLite handles, vector stores, and embedding managers behind a bounded LRU so the daemon doesn't leak file descriptors across many projects. `packages/myco/src/db/client.ts` enforces **per-daemon ownership** of Grove databases — a daemon may only open a database that lives under its own home.

That ownership boundary is what the daemon-coexistence redesign (below) had to make airtight.

# MYCO_HOME and the dev/prod coexistence model

Two Myco daemons — a production install and a local dev build — can run on the same developer machine simultaneously, and `MYCO_HOME` is the boundary that keeps them from colliding. `packages/myco/src/grove/paths.ts`'s `resolveMycoHome()` reads `MYCO_HOME` from the environment and falls back to `~/.myco`; `isDefaultMycoHome()` compares a resolved home against that canonical default to distinguish the shared production install from a non-default (e.g. `~/.myco-dev`) dogfood path.

This wasn't always safe. Before the daemon-coexistence redesign (branch `feat/daemon-coexistence`, 14 tasks, released starting `myco/v1.2.1-beta.1`), dev and prod daemons shared one `~/.myco` home and were distinguished only by a `served_by` label (`'service'` vs `'service-dev'`) — a soft convention, not a hard boundary. A branch binary running against the shared home could silently strip the production daemon's bootstrap anchor (`_unbound-bootstrap/project.toml`), taking down the UI root and `/api/status` while leaving grove data itself untouched — a real incident during that redesign (`feat/daemon-coexistence`, batch 12573).

The redesign replaced the soft label with **physical home separation**: prod runs exclusively in `~/.myco`, dev runs exclusively in `~/.myco-dev`, and every ownership check became path-based rather than metadata-based:

- `assertOwnsDatabase` in `db/client.ts` derives the grove ID purely from whether the DB path starts under `resolveGrovesDir(mycoHome)` — no grove record needs to be read to reject a foreign-home open.
- API-level `groveServedByThisDaemon(grove, mycoHome)` succeeds only if `loadGroveRecord` finds the grove *in that home's own registry* — physically impossible to satisfy for a grove living in the other home.
- Boot mode is `MYCO_DAEMON_MANAGED` (home-scoped global daemon); the old `DaemonVariant`/`service-dev` primitives were deleted outright.
- `runtime.home` is written by `make dev-link` and propagated to hooks, the CLI, and the MCP bridge so every subsystem consistently routes to the same home.
- A narrow, deliberate exception: `MYCO_CLAIMS_HOME` lets the dev daemon share the *machine-global* claims area at `~/.myco/claims/` rather than duplicating it — coordination state that legitimately needs to be visible across homes, unlike grove data which must not be.

That same "some things are genuinely machine-scoped, not daemon-scoped" reasoning was reapplied shortly after: Team configuration was originally stored under `~/.myco/teams/`, which meant the dev daemon (now correctly isolated to `~/.myco-dev`) lost its Team connection entirely once coexistence became physical. The fix moved Team config to its own machine-wide home, `~/.myco-team/`, mirroring the precedent already set by `~/.myco-collective/` — any subsystem that legitimately serves every daemon on a machine gets its own home outside `MYCO_HOME`, rather than being nested inside one daemon's territory.

# Adopt-time re-pointing: the native binary upgrade path

The daemon's own binary is upgraded through an explicit **stage → adopt** flow, not an in-place patch. New versions are downloaded and checksum-verified into `~/.myco/bin/versions/<semver>/myco` while the daemon keeps running; adoption — atomically copying that staged file over the stable `~/.myco/bin/myco` — only happens when the daemon is not capturing: during a `PowerState`-driven idle window, via the UI's "Upgrade & Restart", or via `myco upgrade`. Unlike Claude Code's version-directory-plus-symlink scheme, Myco copies a real file, because Myco always restarts to adopt (no live session needs the old inode to stay valid); a real file also sidesteps symlink/junction complexity and admin-rights requirements on Windows.

The path `~/.myco/bin/myco` is meant to never change per version — hooks, `PATH`, the install marker, and the OS service unit all reference it directly. That invariant has broken in practice at two points worth knowing about if you touch install or upgrade code:

- **Service unit re-pointing at install time.** `ensureSelfInstalledAsService()` bakes in whatever `process.execPath` was current *when the service was registered*. For an npm-bootstrapped install, that's a path inside `node_modules/@goondocks/myco-<target>/bin/myco` — so swapping the binary at `~/.myco/bin/myco` updates a file the OS service never actually executes, and self-update silently no-ops for the whole npm-install base until `convergeNpmInstall` explicitly re-points the service executable.
- **Service config reload at adopt time.** If adopt updates the stable binary but does not reload the loaded launchd/systemd unit, the supervisor relaunches the *old* per-platform binary path recorded at the last service registration — which then re-discovers the newly staged version and re-adopts, in a loop, each cycle rotating the daemon's auth token out from under any active session hooks.

Both failures share a root cause: the binary path and the service unit's record of that path are two different pieces of state, and adopt only updates one of them unless explicitly told to reload the service config too.

# Citations

[1] `packages/myco/src/daemon/main.ts` — daemon entrypoint wiring event ingestion, Grove APIs, MCP, and scheduled work
[2] `packages/myco/src/hooks/client.ts` — hook-to-daemon spawn/health-check/auth-token client
[3] `packages/myco/src/daemon/power.ts` — `PowerManager` pure state machine (`active/idle/sleep/deep_sleep`)
[4] `packages/myco/src/daemon/job-runner.ts` — job dispatch, concurrency, and fairness lanes
[5] `packages/myco/src/grove/database.ts` — per-Grove SQLite creation (`ensureGroveDatabase`)
[6] `packages/myco/src/grove/paths.ts` — `resolveMycoHome`, `isDefaultMycoHome`
[7] `packages/myco/src/upgrade/adopt.ts`, `apply-binary.ts` — stage/adopt binary upgrade flow
[8] Spore `id-hash-52acab05444ca3ce` (architecture) — Daemon Coexistence Redesign complete model
[9] Spore `id-hash-1dd443d38efb2a9d` (gotcha) — branch binary on shared `~/.myco` clobbers prod bootstrap anchor
[10] Spore `id-hash-e70a360c0c1b4940` (decision) — Team config moves to machine-scoped `~/.myco-team/`
[11] Spore `id-hash-34d38c87dee10d05` (wisdom) — Native Binary Distribution and Upgrade System architecture reference
[12] Spore `discovery-b52adf62` — PowerManager → JobRunner refactor callsite fallout
[13] Spore `wisdom-eed0418e` — PowerManager→JobRunner restructure: three scheduling anti-patterns
