# Changelog

All notable changes to Myco are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-06-23

### Headline

**Node-free native installer.** Myco now ships as a self-contained native binary — no Node runtime is required to run it. `curl -fsSL https://myco.sh/install.sh | sh` (macOS/Linux) and `irm https://myco.sh/install.ps1 | iex` (Windows x64) download the binary to `~/.myco/bin` (`%LOCALAPPDATA%\Myco\bin` on Windows), register a managed per-user service, and connect supported agents. `npm install -g @goondocks/myco` still works as a thin bootstrap that converges to the same native binary.

### Added

- **Single-binary self-update.** The local service keeps itself up to date from its release channel in the background while idle. Upgrades can also be triggered from the **Upgrade** section of the dashboard's Settings page or with the new `myco upgrade` CLI (`--channel stable|beta`). `npm update` is no longer part of the main upgrade path.
- **Daemon coexistence.** A development Myco service can run alongside the released production service on the same machine — variant-aware Grove binding keeps their Groves, services, and upgrades isolated.
- **Cross-platform service lifecycle.** Managed per-user service install and supervision across launchd (macOS), systemd (Linux), and Task Scheduler (Windows), validated on macOS, Linux, and Windows x64.

### Changed

- **Install no longer requires Node.** The installer downloads a native binary instead of installing the npm package. Node 22+ is now needed only for the optional npm install path and the operator CLIs (`@goondocks/myco-team`, `@goondocks/myco-collective`).
- Platform support: macOS is the primary supported platform; Linux and Windows are in beta. Windows is x64 only — Windows on ARM is not supported.

## [Unreleased]

### Headline

**Zero-config global install.** Install once, every project works. `myco init` is no longer required (or available as a bare command) — the service auto-registers during `npm install -g`, the daemon auto-starts, and projects are auto-registered to a default Grove on the first agent hook.

### Added

#### Global symbiont install architecture

- All 8 symbionts (Claude Code, Cursor, Codex, Copilot, Antigravity, Windsurf, OpenCode, Pi) install once at each agent's global configuration location, not per-project. Local `.agents/` folders are no longer required.
- Two global launchers — `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs` — bridge every agent's hook + MCP system to the daemon. Project-local launchers can override per-project.
- Capture buffer relocated under `~/.myco/buffer/` (per-Grove subdirectories). Legacy `.agents/myco-buffer/` is archived during migration.
- Per-project archives of prior `.agents/` artifacts are written on migration — auditable and restorable, but inert.
- **Project overrides moved to the dashboard's Symbionts page.** Disable/enable a symbiont in a specific project via UI rather than CLI flags.
- New manifest fields: `detectionDir`, `globalHooksTarget`, `globalMcpTarget` (string or string[]), `globalSettingsTarget`.
- Settings-merge for shared agent config files: Myco's hook/mcp/skills entries are upserted; user-pre-existing keys (e.g. Codex `[features].hooks`) are preserved across install/uninstall cycles.

#### Default Grove + auto-register projects

- **A default Grove is created at install.** Projects auto-register into it on first agent hook — no `myco init` step. Hooks fired from non-git directories (cwd-fallback misfires) are silently skipped.
- Users can create additional Groves and reassign projects between them through the dashboard.
- **Variant-aware Grove binding**: dev daemons (`MYCO_SERVICE_VARIANT=dev`) bind only to Groves with `served_by="service-dev"`; prod daemons only to `served_by="service"`. Dev and prod can coexist on the same machine — each gets its own default Grove. The previous prod-side escape hatch (default Grove regardless of `served_by`) is closed.

#### Antigravity symbiont (Gemini IDE successor)

- New symbiont with full CLI + IDE + app surface coverage.
- PreInvocation transcript-read for user-prompt capture.
- PostInvocation spore injection with per-prompt deduplication.
- Stop processor reconciliation invokes transcript re-enrichment for symbionts whose hooks lack prompt/summary data.
- Launcher reads `workspacePaths` from stdin for multi-agent workspaces.
- One-time data remap migrates legacy `~/.gemini/` artifacts and cleans stale `trusted_hooks.json` entries.

#### Unified injection-records helper

- `recordInjectionActivity()` is the single injection path for Cortex, Spores, and Canopy. UNIQUE-index dedup, log-payload scrubbing (no `injected_text` in INFO logs), `recordInjectionAndShouldSuppress()` wrapper for unified call sites.
- Cortex injection gated on AGY's `invocationNum === 0` — fires only once per session start.
- Distinct UI rendering for `myco:*` injection activity rows.

#### Daemon state authority

- `DaemonStateAuthority` is the only path for `daemon.json` mutation. Raw `writeOrTouchDaemonState` is no longer reachable. Every write logs reason, caller-pid, and before/after PID.

#### Sandbox-safe service install

- New `MYCO_LAUNCH_AGENTS_DIR` env var lets sandboxed test installs target a non-default LaunchAgents/systemd-user directory.
- Sandbox installs get a label suffix (`co.goondocks.myco-dev.sandbox-<8hex>`) so they cannot collide with canonical service registrations.
- `MYCO_LAUNCH_AGENTS_DIR` is propagated into the plist `EnvironmentVariables` block so child daemons spawned by `RunAtLoad: true` inherit the same sandbox context.
- Production behavior is byte-identical when the env var is unset.

#### Symbionts page in daemon UI

- Live status of every detected symbiont, with re-detect trigger.
- Per-project override controls.

#### `myco doctor` expansions

- Detects `cursor-cd-cwd` missing prefix, Claude-matcher emptiness, hybrid-TOML state, project-local stub residue.
- Surfaces migration audit log + service registration state.

#### `myco remove` and `myco remove --purge`

- Clean removal of Myco's contributions to every agent's global config, preserving user-pre-existing keys.
- `--purge` additionally removes `~/.myco/` itself.

#### Skills

- New bundled skill `myco-okf`: create and maintain an OKF-conformant project wiki from your project's Myco intelligence.

#### Tests

- New invariant test suites: launcher write-ordering, daemon-bound intent bypass, daemon rebind on first project, variant-aware rebind filter, canonical-plist-no-hijack, greenfield default-Grove + first-hook auto-register end-to-end.
- `MYCO_LAUNCH_AGENTS_DIR` propagation regression tests in `tests/service/`.
- Test isolation hardened: `--isolate` runner enforcement, MYCO_HOME sandboxing in `beforeEach` for relevant suites.

### Changed

- **Default install path is global.** `npm install -g @goondocks/myco` (or the install script) is the only step. No per-project setup required.
- Symbiont rename: `vscode-copilot` → `copilot`, with multi-target MCP for Copilot CLI + IDE.
- Claude Code hook templates now include `matcher: ""` in every hook group, enforced by invariant test.
- Cursor hook commands now include `cd ${CURSOR_PROJECT_DIR:-.}` prefix; invariant test enforces a `cd` prefix on every global hook template for its agent's project-dir env var.
- OpenCode MCP transport switched from relative-path stdio to remote/URL.
- Windsurf manifest hookFields aligned with current Cascade payload schema.
- License relicensed from MIT to **Apache 2.0** on 2026-04-29 (commit 57a9571a). Marketing site and docs updated accordingly.

### Removed

- `myco init` CLI command — entirely. Both the bare invocation and the `--project <path>` form. Project setup is fully automatic on global install; per-project overrides (portable Grove identity, dogfood binary pinning, project-local launcher) move to the dashboard's Symbionts page.
- `--worktree` flag.
- Per-project `.agents/myco-buffer/` location (replaced by `~/.myco/buffer/`, with migration archive in each project).

### Fixed

- **Limit-cap saturation in `syncTranscriptPromptBatches`** (`event-handlers.ts`): swapped `listBatchesBySession` (capped at 200) for `countBatchesBySession` + `insertBatchStateless`, wrapped in `db.transaction()` for fsync win.
- **React Hooks violation in `ActivityList.tsx`**: `useState` was called after an early return for `MycoInjectionItem`; dispatch moved to parent component.
- **Codex `[features].hooks` data loss on `myco remove`**: audit-track TOML settings preserves user-pre-existing keys.
- **Brownfield walker orphan stubs**: walker now cleans up unregistered legacy projects (was registry-driven only).
- **Cross-Grove walker boundary**: enforced via `served_by` filter (R3.0). Audit pass on all `listGroves()` callers.
- **TOML upsert newline bug** in `buildTomlMcpSection`.
- **`/api/symbionts/detect` entry point** now calls `runGlobalBootstrap`, not `runSymbiontDetection`.
- **Layered launcher path resolution**: `runtime.command` dispatch correctly resolves project-local override → global launcher → daemon binary.
- **Atomic writes for every agent-config write** (was inconsistent across symbionts).
- **Canopy mass-delete bug**: walker scope correctly differentiates project root vs grove root.
- **Daemon-bound `installGlobalLaunchers` infinite no-op**: added `skipIntent` parameter so the reconciler can bypass its own intent-routing.
- **`MYCO_LAUNCH_AGENTS_DIR` not propagated to launchd child daemons**: caused the canonical `~/Library/LaunchAgents/co.goondocks.myco-dev.plist` to be overwritten during sandbox installs. Fix propagates the env var through the plist `EnvironmentVariables` block.
- **Stop processor empty-named buffer events** no longer overwrite parser breakdown.
- **`prompt_count` / `tool_count` drift** in sessions: now derived from row scans.

### Security

- All migration writes go through audit logging (bounded). Migration completion surfaces a notification with audit-trail summary.

---

## Notes for upgraders

### From v0.25.x (or earlier)

If you have an existing per-project `.agents/` install in a project:

1. Upgrade Myco globally: `npm install -g @goondocks/myco@latest`.
2. The daemon restarts and runs the migration walker on next start.
3. Per-project `.agents/` artifacts are archived in-place; agent global configs are updated to point at the new global launchers.
4. The Symbionts page in the dashboard shows the new global install state.

No `myco init` invocation needed. Run `myco doctor` after upgrade to validate.

### From per-machine MIT-era installs

The license changed from MIT to Apache 2.0 on 2026-04-29. No code action required, but if your team's compliance review tracks license metadata, re-acknowledge.

---

[Unreleased]: https://github.com/goondocks-co/myco/compare/myco/v1.2.0...HEAD
[1.2.0]: https://github.com/goondocks-co/myco/releases/tag/myco/v1.2.0
