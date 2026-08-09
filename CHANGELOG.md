# Changelog

All notable changes to Myco are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.1] - 2026-08-09

### Fixed

- **Session durations are recorded correctly again.** Agents that re-announce a session mid-flight (Claude Code after a context compaction or resume, Codex Desktop periodically, Pi after compaction) were rewriting the session's start time on every re-announcement — a session spanning days could show as minutes. Re-registration is now additive: the earliest start time wins, and details already recorded (branch, lineage, project root) are never erased by a sparser re-announcement.
- **Long Claude Code sessions no longer split into disconnected sessions.** Recent Claude Code builds continue a conversation under a new session id when the context window fills. Myco now links the continuation to its predecessor (sessions carry a "compact continuation" parent) and files the continuation summary as system context instead of displaying it as an enormous prompt you never typed.
- **Empty "recovered" sessions no longer accumulate.** Launching an agent and quitting before typing anything left behind one-prompt phantom sessions reading "(implicit batch — capture recovered)". These are now cleaned up automatically, with deliberately conservative guards: a session holding any real prompt, captured response, transcript on disk, or not-yet-replayed buffered events is never touched — and if you come back and type after a cleanup, capture resumes seamlessly.
- **Project file descriptions stay fresh for every agent.** The per-edit Canopy refresh only recognized Claude Code's tool names, so projects driven by Pi, Codex, Copilot, and others went stale between hourly background scans (a daemon restart appeared to fix it — briefly). Each agent's own edit vocabulary now triggers the refresh, and every turn-end nudges a scan, so descriptions follow the work no matter which agent does it.

## [1.4.0] - 2026-08-08

### Headline

**Team Host now reaches its members over public HTTPS, not a private overlay.** A host publishes its team surface at a public address through its own Tailscale Funnel (`https://<machine>.<tailnet>.ts.net:8443`); members hold only that address and a per-member token, dial it like any HTTPS endpoint, and join no network. There is nothing for a member to install — no Tailscale, no tailnet — and the host provisions no networking stack of its own: it uses the Tailscale the operator already runs. The retired model (a Myco-provisioned headscale control plane + WireGuard overlay, with a Homebrew-installed client on macOS) is gone.

### Changed

- **`myco host enable` no longer takes an address.** The host used to be told the URL members would dial (`--server-url`); it now learns its own public address from Tailscale Funnel after the daemon restarts, and `myco host status` prints it. The `--serve` installer flag likewise drops `--server-url` — `curl … | sh -s -- --serve` is the whole command.
- **Per-member tokens.** Each enrolled machine holds its own bearer token bound to its machine identity, rather than sharing one host bearer.

### Added

- **`myco host members`** lists the machines enrolled on a host, and **`myco host revoke <member-id>`** removes one — the recovery path for a machine that was wiped or replaced and can't re-join under its own identity.

### Breaking

- **The `myco join` command shape changed.** It is now `myco join <host> --key <one-time-key> --host-url <https://host.tailnet.ts.net:8443>`. The retired `--server-url` and `--overlay-address` flags are gone; a member holds the host's public URL and a key, nothing else. Re-mint a join command from the host (dashboard **Invite a member**, or `myco host rotate-key`) and re-run it on any machine still using the old form.
- **Windows still cannot host or join a team** (unchanged), and the team transport is served over a Unix-domain socket, which Windows does not provide.

### Upgrade & rollback

- **Update the host before members, and have members re-join after they update.** A member on 1.3.x dials the old overlay address, which now resolves nowhere; it reports a timeout and cannot know to update. After upgrading, that member re-joins with the new `--host-url` form (a fresh key from the operator) to pick up the public address.
- **Before downgrading a machine below 1.4.0, run `myco leave <host>` for every host it has joined.** A 1.4.0 host record omits the `overlay_address` a 1.3.x daemon requires at boot; left in place, the older daemon refuses to start and takes local capture down with it, and 1.3.x cannot clear the record itself. Leaving each host first removes the record cleanly. If you have already downgraded and the old daemon won't start, re-upgrade to 1.4.0, run `myco leave`, then downgrade.

## [1.3.2] - 2026-08-03

### Fixed

- **The dashboard address can no longer be silently taken over by another local process** (#835). The daemon previously listened on IPv4 loopback only, leaving the IPv6 side of its port (`[::1]`) unclaimed — and browsers often try IPv6 first for `localhost`. Anything that grabbed that free side (a leftover `ssh -L` port forward, a dev tunnel) would quietly receive your dashboard traffic and present a different daemon at your production URL. The daemon now claims its port on both loopback stacks, so while it is running, any process attempting to take either side fails immediately with a clear address-in-use error. If something already holds the IPv6 side when the daemon starts, the daemon comes up normally on IPv4 and logs an error identifying the conflicting listener and how to find it.

## [1.3.1] - 2026-08-02

### Headline

**Hosting a team is now something you do in the dashboard.** The Team page opens on the choice that actually matters first — host a team, or join one — and hosting runs entirely as your user: no sudo, no administrator password, on macOS and Linux alike. A host set up this way serves while you're logged in; `myco service install` makes it survive reboots unattended.

### Added

#### Team hosting in the UI

- **Host a team from the Team page** (#803, #800). A form takes the address teammates will dial, a name for the team's storage, and an optional host label, then stands the host up with a live step log and survives a mid-run page refresh. Team storage is created fresh for the team — existing projects are never designated silently.
- **Mint join key and Stop hosting**, both from the same page (#803). Minting reveals a one-time key and the complete ready-to-paste `myco join …` command once. Stopping tears the host down but leaves the team's storage in place; hosting again picks that storage back up with its history intact.
- **Zero-sudo hosting on the default path** (#799). Overlay supervision follows the local service's own scope instead of being pinned to the system domain. The one remaining elevated case is a macOS machine whose service already starts at boot; the dashboard says so and points at the CLI.

#### Per-host configuration

- **Three tabs on a connected Team page** (#803, #802): Team (hosts, membership, project attach, capture delivery), External access, and Settings. The host-scoped tabs target hosts by identity (#802), so a host with no projects attached yet is a first-class, fully configurable target — and members get the same editors as the host.
- **External access** moved up into its own tab, showing the public read-only address, the one-time token reveal, token rotation, and a ready-to-paste MCP configuration block for the tool you're connecting.

### Changed

- **One binary-resolution contract across every consumer** (#801), so the managed binary is located the same way from the CLI, the service, and the installer paths.
- The Team page is machine-scoped (#802) and its tab and host selection live in the URL, so a view is linkable and survives the reload the enable flow performs.

### Breaking

- **`myco host enable` requires an explicit designation on a machine that already has project storage.** The first enable now refuses without `--designate-fresh` (new storage dedicated to the team, named with `--storage-name`) or `--designate-default` (serve this machine's default project storage — what the `--serve` installer path does). Storage you already use is never designated for a team silently. Enabling again later adopts the team storage from before, history intact; a different `--storage-name` starts new storage and keeps the old on the machine. The `--serve` installer path is unaffected — it passes `--designate-default` itself.

### Removed

- **Collective documentation.** The Collective's daemon integration was retired in 1.3.0 and its guide is gone from the docs site; the dormant `@goondocks/myco-collective` package is unchanged.

## [1.3.0] - 2026-08-02

### Headline

**Team Host residency: projects can move to a shared host — and come back.** Attaching a project to a Team Host now moves its full history to the host, which becomes the single copy while attached; teammates work against the same knowledge with per-project tenancy enforced on every write. Detaching brings everything home in one digest-verified, resumable transfer that restores your local copy before the switch — no window where reads come up empty.

### Added

#### Team Host

- **Attach with history / detach with history.** A project's sessions, spores, plans, and skills travel to the host on attach and return on detach. Detach transfers are chunked, digest-verified, and resumable; the host reclaims departed machines and refuses writes from stale members.
- **Multi-host Team page.** Manage several hosts from one dashboard: membership, per-host status and health, served-Grove designation, drain health, and garbage collection.
- **Server mode in the main binary.** Hosting is a mode of `myco` itself — no separate operator package to install.
- **Leaving is safe by construction.** `myco leave` is refused while any of your projects is still attached (detach each first), and while a project move involving that host is in flight.

#### External read-only agent access

- Opt-in, per-machine: expose a read-only slice of your team knowledge (six read-only tools) to agents running elsewhere, over a private Unix socket fronted by Tailscale Funnel. Token-gated with one-time reveal and rotation; disable verifiably tears everything down. macOS and Linux only.

#### Service scope

- `daemon.service_scope` (machine config): run the local service at `login` (default) or at `boot` on macOS and Linux. Boot scope keeps the service supervised across upgrades and reboots without a logged-in session. Windows keeps login scope via Task Scheduler.

#### Upgrade safety

- **Storage-format updates now take an automatic pre-update backup** into the affected Grove's backup folder, pinned so retention cleanup keeps the most recent checkpoints. If the backup cannot be taken, the storage-format update is refused and your data is left untouched.
- **Rollback is refused across a storage-format change** — automatically after a failed update and via explicit downgrades — instead of leaving a service that cannot start. `myco doctor` explains exactly which versions are involved and what to do.

#### Skills

- **Review-then-publish.** Agent-proposed skills now live in Myco's database until you publish them; the Publish action is what writes a skill to your project for agents to load. No more silent skill file changes.
- **New bundled skills**: `/myco-okf` creates and maintains an OKF-conformant project wiki from your Myco intelligence; `/myco-handoff` hands work off between sessions with plans and context intact.

### Changed

- **Capture fidelity**: prompt/response attribution hardened across compaction, subagent, and replay paths; Myco's own background agent runs no longer pollute session capture.
- **Agent harness sign-in**: Claude subscription setup lives in Settings; auth failures raise an actionable notification instead of failing silently.
- **Overlay networking**: the host overlay runs on Myco-provisioned, content-addressed binaries with drift detection in `myco doctor` (macOS uses your Homebrew tailscale — installed once with disclosure, never upgraded or removed by Myco). Disabling a host verifies teardown before destroying state.

### Removed

- **Team Sync (Cloudflare) and the Collective daemon integration.** The legacy background sync stack — D1 mirror, sync worker transport, and the Collective's daemon hooks — is retired. Team Host residency is its replacement. The `@goondocks/myco-team` and `@goondocks/myco-collective` operator packages are dormant pending redesign.

### Fixed

- **`npm update -g` no longer breaks the `myco` command.** The launcher now survives npm re-extracting the platform package (deleted dispatch file, lost executable bit) by falling back to the managed binary, and `myco doctor` checks that the command on your PATH is healthy.
- **Explicit downgrades across a storage-format change are refused** even when version numbers alone look safe — the same guard that protects automatic rollback now applies in both directions.
- **Disabling external agent access works on machines without Tailscale installed** — teardown verification no longer requires the CLI it was checking for.
- **External agent access answers at the advertised URL** — Tailscale Funnel strips the path prefix it mounts, and the listener now accepts the stripped form.
- The Windows installer no longer suggests the dormant Collective CLI.
- Reliability fixes across detach/attach edge cases, capture reconciliation, and daemon restart supervision; see the GitHub release notes for the full list.

### Security

- Every write path into a Grove now passes tenancy admission: cross-project and cross-Grove writes are refused with typed errors, project lifecycle operations are gated while transfers are in flight, and served hosts refuse requests outside the served Grove.

### Notes for upgraders (from 1.2.x)

- **Storage format advances from v66 to v76** on first start. The update takes the automatic pre-update backup described above; no action needed.
- **Legacy Team Sync queue is cleared.** Any capture rows still queued for the retired Cloudflare sync at upgrade time are discarded along with the sync membership; your local data is unaffected.
- **Teams: update the host first, then members** — see the Team Host guide.
- Point releases between the sections here (v1.0.x, v1.1.x, and v1.2.1 through v1.2.13) shipped without changelog entries — installer, self-update, and platform hardening; their notes live on the [GitHub releases page](https://github.com/goondocks-co/myco/releases).

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

## [1.0.0] - 2026-05-31

_(Recorded retroactively — this section previously sat mislabeled as "Unreleased" below 1.2.0.)_

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

[1.3.0]: https://github.com/goondocks-co/myco/releases/tag/myco/v1.3.0
[1.2.0]: https://github.com/goondocks-co/myco/releases/tag/myco/v1.2.0
[1.0.0]: https://github.com/goondocks-co/myco/releases/tag/myco/v1.0.0
