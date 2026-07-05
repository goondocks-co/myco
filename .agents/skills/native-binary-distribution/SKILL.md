---
name: myco:native-binary-distribution
description: |
  Apply this skill when working on native binary installation, upgrade pipelines,
  daemon binary path management, or dev/prod daemon coexistence for the Myco
  native installer. Covers: the steady-state binary path model
  (e.g., issues with code-signing on macOS have now been addressed and should be reflected in plist self-heal), the looksLikeDevBuildExecutable()
  service-mutation guard, managedBinaryPath() usage, the MYCO_HOME physical
  boundary model (prod ~/.myco vs dogfood ~/.myco-dev) that replaced the
  deprecated detectDevBuild() pattern, upgrade-path validation (confirm plist
  self-heal before testing), beta rollout sequencing for install-path changes,
  and the self-propagation trap requiring GA-gating any upgrade-path fix. Use
  this skill whenever code touches binary paths, service install/uninstall,
  upgrade exemption, plist config, or daemon coexistence.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Native Binary Distribution and Installer Pipeline

Myco's native installer places the daemon binary at a managed stable slot
(`~/.myco/bin/myco`) via plist self-healing, distinct from the npm global prefix
(`/opt/homebrew/...`). This creates a two-path world that every piece of upgrade,
coexistence, and service-mutation guard must understand. Getting the boundary wrong
silently breaks service install, upgrade paths, or coexistence for every real user.

## Prerequisites

Understand the two production binary locations:

1. **npm-package path (transient)** — e.g., `/opt/homebrew/lib/node_modules/myco-darwin-arm64/bin/myco`.
   Present immediately after `npm install -g`. Falls *under* the npm global prefix.
2. **Managed stable slot (steady state)** — `~/.myco/bin/myco`. Reached after the launchd
   plist self-heals post-install. This is where every real user's daemon runs permanently.

Key source files:
- `packages/myco/src/install/managed-binary.ts` — `managedBinaryPath()` (production slot)
- `packages/myco/src/service/spec-builder.ts` — `looksLikeDevBuildExecutable()`, `buildServiceSpec()`
- `packages/myco/src/cli/service.ts` — `assertSafeServiceMutation()`, `resolveServiceExecutable()`
- `packages/myco/src/daemon/update-checker.ts` — `resolveMycoBinary()`, `releaseChannelIsManual()`

Service identity helpers: `serviceLabel()`, `defaultServiceExecutable()`, `ensureSelfInstalledAsService()`.

Quick diagnostic — check upgrade status on a running daemon:
```bash
curl -s http://localhost:<port>/api/upgrade/status | jq '{update_available, channel, channel_scope, running_version}'
```

## Procedure A: Understanding the Steady-State Path Model

After a native install, the daemon moves through two phases before reaching steady state.

**Phase 1 — Fresh install (transient).** The daemon runs from the npm-package path, e.g.,
`/opt/homebrew/.../myco-darwin-arm64/bin/myco`. This falls under the npm global prefix.

**Phase 2 — Steady state (permanent).** The launchd plist self-heals to point at
`~/.myco/bin/myco` (the `managedBinaryPath()`). Every real user reaches this state after
first install. Any code that assumes "production = npm prefix only" breaks at steady state.

### The Managed Binary Path API

Always obtain the production binary location via `managedBinaryPath()`:

```ts
// packages/myco/src/install/managed-binary.ts
import { managedBinaryPath } from '../install/managed-binary.js';
const dest = managedBinaryPath(mycoHome, platform, process.env.LOCALAPPDATA);
// → ~/.myco/bin/myco (macOS/Linux), %APPDATA%\myco\bin\myco.exe (Windows)
```

`managedBinaryPath()` is the authoritative source for the production binary path.
Never hardcode `~/.myco/bin/myco` as a literal — use this function.

### The Upgrade API Response Shape

Current `/api/upgrade/status` response fields (note: `update_exempt` is not part of this API):

```json
{
  "update_available": false,
  "revert_available": false,
  "running_version": "1.2.0",
  "latest_version": "1.2.0",
  "channel": "stable",
  "channel_scope": "machine",
  "runtime_scope": "machine",
  "check_interval_hours": 6,
  "last_check": "2026-06-01T12:00:00.000Z",
  "packages": [...]
}
```

If `update_available` is unexpectedly `false` when a newer build is published, check:
1. Is `channel` set to `manual`? Manual channel suppresses auto-check.
   (`releaseChannelIsManual()` reads `daemon.update_channel` from machine config.)
2. Is `last_check` stale? The check interval may not have elapsed.
3. Is the daemon actually running from `~/.myco/bin/myco` (confirm plist self-heal)?

## Procedure B: Dev/Prod Boundary — `looksLikeDevBuildExecutable()` and `MYCO_HOME`

The production/dev distinction is enforced at two levels: the **binary path pattern**
and the **MYCO_HOME boundary**. These replaced the deprecated `detectDevBuild()` function
(which existed in an earlier beta era and misclassified the managed stable slot as a dev
build, blocking all upgrade surfaces simultaneously — see architectural note below).

### Current Dev-Build Detection: `looksLikeDevBuildExecutable()`

Located in `packages/myco/src/service/spec-builder.ts`:

```ts
export function looksLikeDevBuildExecutable(executable: string): boolean {
  const platformPkgPattern = /\/packages\/myco-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)\/bin\//;
  const legacyVendorPattern = /\/packages\/[^/]+\/vendor\//;
  return platformPkgPattern.test(executable) || legacyVendorPattern.test(executable);
}
```

A dev-build binary has a path containing `/packages/myco-<arch>/bin/` or `/packages/<pkg>/vendor/`.
The npm global install always has `node_modules/` in the path and never matches these patterns.
The managed stable slot (`~/.myco/bin/myco`) also never matches — it is correctly treated as production.

**This function guards service mutations only** — it prevents a dev binary from installing
itself as the prod daemon's launchd plist. It is NOT used for upgrade exemption.

### The Service Mutation Fence: `assertSafeServiceMutation()`

Located in `packages/myco/src/cli/service.ts`:

```ts
export function assertSafeServiceMutation(
  parsed: ParsedServiceArgs,
  execPath: string,
  mycoHome: string = resolveMycoHome(),
): string | null {
  const mutating = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'reconcile']);
  if (!isDefaultMycoHome(mycoHome)) return null;           // non-default home = ok
  if (!mutating.has(parsed.action)) return null;           // status = ok
  if (!looksLikeDevBuildExecutable(execPath)) return null; // prod binary = ok
  return `Refusing to ${parsed.action} ...`;               // dev binary + default home = blocked
}
```

This is the CLI boundary. `buildServiceSpec()` enforces the same check at the spec level,
checking both the literal path and its `realpathSync` target to prevent symlink bypass.

### The Primary Boundary: `MYCO_HOME`

Coexistence of prod and dev daemons is achieved via separate home directories:
- **Prod daemon**: `MYCO_HOME=~/.myco` (the default home every released user has)
- **Dev/dogfood daemon**: `MYCO_HOME=~/.myco-dev` (a separate home set in the dev plist)

When `MYCO_HOME` is not the default (`isDefaultMycoHome()` returns `false`), the dev daemon
can freely manage its own service without triggering the mutation fence. All grove data,
service config, and upgrade state are isolated by `MYCO_HOME`.

### Architectural Note: Why `detectDevBuild()` Was Removed

The deprecated `detectDevBuild()` function classified binaries by checking if `process.execPath`
fell under the npm global prefix. Once the plist self-heals to `~/.myco/bin/myco`, that path
is NOT under the npm prefix, so `detectDevBuild()` returned `true` (dev build) for every
production native install at steady state. This simultaneously blocked all five upgrade
surfaces (`/api/upgrade/check`, `/api/upgrade/apply`, auto-adopt job, `myco upgrade` CLI,
and status). The fix replaced path-based runtime classification with the `MYCO_HOME` boundary
model and moved dev-binary detection to service-install time via `looksLikeDevBuildExecutable()`.

### Checklist: When Adding a New Binary Location

1. Verify `managedBinaryPath()` returns the new path — update it if a new platform is added.
2. Verify `looksLikeDevBuildExecutable()` does NOT match the new path (update regex if needed).
3. Verify `buildServiceSpec()` does not reject the new path.
4. Run a full upgrade cycle from **steady state** (plist self-heal confirmed) — see Procedure C.

## Procedure C: Upgrade-Path Validation Protocol

Before any GA release, validate the upgrade path from **steady state**. Fresh-install
tests give false confidence because the daemon is still at the npm path.

### Why Fresh-Install Tests Miss Path Bugs

Immediately after `npm install -g`, the daemon runs from
`/opt/homebrew/.../myco-darwin-arm64/bin/myco`. Only after plist self-heal moves
it to `~/.myco/bin/myco` does any managed-path-specific bug appear.

> **Rule:** upgrade tests MUST be run after confirming plist self-heal, not immediately
> after `npm install -g`. This is how steady-state GA blockers are caught.

### Validation Steps

1. Install the target build: `npm install -g myco-darwin-arm64@<version>` + daemon restart.
2. Confirm plist self-heal: verify the launchd plist `Program` points at `~/.myco/bin/myco`.
   ```bash
   cat ~/Library/LaunchAgents/com.myco.daemon.plist | grep Program
   # Should show: <string>/Users/<user>/.myco/bin/myco</string>
   ```
3. Check upgrade status from steady state:
   ```bash
   curl -s http://localhost:<port>/api/upgrade/status | jq '{update_available, channel, running_version}'
   ```
4. Publish a newer build. Confirm `update_available: true` appears within one check cycle.
5. Test auto-adopt: wait for the idle job to fire and apply the update.
6. Test manual upgrade: call `/api/upgrade/apply` or `myco upgrade` from CLI.
7. Test revert → re-upgrade: downgrade to a prior version, confirm upgrade works again from steady state.

### Zero-Migration Check

For minor version upgrades, verify that restarting the daemon
produces zero pending migrations — the install path change should not trigger schema drift.

## Procedure D: Beta Rollout Sequencing for Upgrade-Path Fixes

When the bug being fixed is in the upgrade path itself, auto-adopt cannot deliver the fix.
The mechanism that would deliver the patch is disabled by the bug being patched.

### The Self-Propagation Trap

A daemon running with a broken upgrade path is effectively frozen — it cannot auto-adopt
the build containing the fix.

```
daemon (broken upgrade path) → cannot auto-adopt the fix build
                             → requires manual installer hop to fixed build
                             → after manual hop, auto-adopt works again
```

There is no self-healing path for users already on the broken build.

### Required Build Sequencing

| Build    | Role                                                                          |
|----------|-------------------------------------------------------------------------------|
| beta.N   | First native-install test; bug surfaced in plist-self-heal steady state       |
| beta.N+1 | Adopt target (published, waiting); remains blocked by the upgrade-path bug    |
| beta.N+2 | Fix build — requires **manual installer hop** to reach from earlier betas    |
| beta.N+3 | **Actual auto-adopt test target** — must be cut *after* fix build lands      |

Why not reuse beta.N+1 as the adopt target after the fix lands? Because the fix build
(N+2) has a higher version number than the original adopt target (N+1) — it cannot
be adopted "down" to N+1. Cut a fresh build after the fix ships.

### GA Gate Requirement

Any fix to the upgrade path or dev-build boundary is a **hard merge blocker** for the
GA release it targets. If GA ships without the fix:
- Every native install reaches steady state (plist self-heals to `~/.myco/bin/myco`)
- Users become permanently unable to auto-adopt any newer build
- Recovery requires another manual reinstall

> "Good that the dogfood test caught it in beta." — this class of bug is invisible in
> CI and only surfaces in steady-state native installs.

## Procedure E: Dev/Prod Daemon Coexistence via `MYCO_HOME` and `MYCO_CLAIMS_HOME`

### Why `MYCO_HOME` Is the Correct Coexistence Mechanism

The `MYCO_HOME` boundary makes each daemon instance self-describing via environment,
not installation path. The dev daemon sets `MYCO_HOME=~/.myco-dev` in its launchd plist.
All service management, grove binding, and upgrade state derives from this value.
No binary needs to inspect its own path to determine which kind of daemon it is.

### Home-Identity Label Model (`serviceLabel()`)

The OS service label (launchd on macOS, systemd --user on Linux) is derived from the
`MYCO_HOME` path — not from a prod/dev variant enum. This is the core change from the
daemon-coexistence design, implemented via `serviceLabel(mycoHome)`:

- **Default home** (`~/.myco`) → `SERVICE_LABEL_PROD` — the stable constant for the
  production daemon label. Existing installs depend on this value; it must never change.
- **Non-default home** (e.g., `~/.myco-dev`) → `SERVICE_LABEL_PROD` + a `.{8-char-hash}`
  suffix derived from a SHA-256 hash of the resolved home path.

This prevents two daemon instances with different `MYCO_HOME` values from clobbering
each other's `launchctl bootstrap` registration in the shared `gui/<uid>` domain. Always
obtain labels via `serviceLabel(mycoHome)` — never hardcode the label string.

### Non-Default Home Always Uses `process.execPath` for Service Executable

`defaultServiceExecutable(mycoHome, platform)` governs which binary the service unit
points at:

- **Default home** (`~/.myco`): prefers `managedBinaryPath()` (`~/.myco/bin/myco`) when
  it exists; falls back to `process.execPath`. This means a self-update's in-place binary
  swap takes effect on next supervisor restart without rewriting the service unit.
- **Non-default home** (e.g., `~/.myco-dev`): **always** returns `process.execPath`, never
  `managedBinaryPath()`. This is a correctness invariant: a dogfood daemon must never have
  its unit pointed at the prod managed binary — that would silently run released code as
  the dogfood unit, violating home isolation.

### Daemon Startup Self-Install (`ensureSelfInstalledAsService()`)

The daemon self-installs as an OS service at startup. At launch it checks whether the
platform supervisor already has a unit for this home's `serviceLabel()`. If not (or if
the unit spec changed), it installs/updates one via `buildServiceSpec()`. On subsequent
restarts it finds the unit present and no-ops (idempotent).

The function also calls `mgr.pruneSupersededUnits()` to sweep away units whose target
binary is gone (old version directories, removed dev-build worktrees), so the supervisor
stops respawning dead processes.

Self-install is non-fatal: failures log at `warn` and the daemon continues serving.
Use `myco doctor` to surface installation gaps.

### `MYCO_CLAIMS_HOME` for Subsystem Claims Sharing

When `MYCO_HOME` is not the canonical home, `buildServiceSpec()` automatically injects
`MYCO_CLAIMS_HOME` pointing at the canonical home into the plist environment
(`packages/myco/src/service/spec-builder.ts`):

```ts
// When MYCO_HOME is not the canonical home, point subsystem claims at the
// canonical home so prod and dogfood share one area.
if (!isDefaultHome) {
  env.MYCO_CLAIMS_HOME = resolveMycoHome({ env: {} });
}
```

The dev daemon at `~/.myco-dev` reads `MYCO_CLAIMS_HOME` (in
`packages/myco/src/grove/subsystem-claim.ts`) to redirect its subsystem registrations
to the canonical home — so prod and dogfood share one global symbiont state area without
collision. This is set automatically by `buildServiceSpec()`; you do not need to write
it into the dev plist manually.

### Five Consumers of Daemon Identity

| Consumer               | Current mechanism                                                    |
|------------------------|----------------------------------------------------------------------|
| OS service label       | `serviceLabel(mycoHome)` — hash of home path; stable per home        |
| Service executable     | `defaultServiceExecutable(mycoHome)` — prod prefers managed slot     |
| Service-dir routing    | Derived from `MYCO_HOME` (default → prod, else dev)                 |
| Port assignment        | Derived from `MYCO_HOME` / service-dir                              |
| Grove binding          | `MYCO_HOME`                                                          |
| Subsystem claims       | `MYCO_CLAIMS_HOME` (auto-set by `buildServiceSpec()`)               |
| Service mutation guard | `looksLikeDevBuildExecutable` + `isDefaultMycoHome`                 |

Upgrade exemption is NOT a consumer — it is only suppressed by `channel: manual`.
A dev daemon in `~/.myco-dev` runs its own upgrade pipeline without exemption.

### Migration Steps When Adding a New Daemon Instance Type

1. Add `MYCO_HOME=<new-home>` to the daemon's plist environment.
2. Verify `isDefaultMycoHome(newHome)` returns `false` — so `assertSafeServiceMutation`
   does not block the new instance from managing its own home.
3. The service label is derived automatically via `serviceLabel(newHome)` — do not
   hardcode a label string.
4. `MYCO_CLAIMS_HOME` is set automatically by `buildServiceSpec()` when the home is
   non-default. Confirm the new instance builds its plist via `buildServiceSpec()`
   rather than constructing the env manually.
5. Do NOT add path-based detection to upgrade or exemption logic.

## Cross-Cutting Gotchas

**The upgrade API has no `update_exempt` field.**
That field existed in an earlier beta era and was removed when `detectDevBuild()` was
eliminated. Stale docs or tests referencing `update_exempt` are incorrect. Current API
fields: `update_available`, `revert_available`, `channel`, `channel_scope`, `runtime_scope`.

**Manual channel is the only remaining upgrade suppression mechanism.**
`releaseChannelIsManual()` in `update-checker.ts` checks `daemon.update_channel === 'manual'`.
This is the only way upgrades are suppressed now (aside from being current). Dev daemons
in `~/.myco-dev` are not exempt — they upgrade normally.

**Steady-state testing cannot be skipped.**
A passing upgrade test immediately after `npm install -g` (daemon still at npm path) gives
false confidence. The plist self-heal must complete and the daemon must be at `~/.myco/bin/myco`
before upgrade tests are meaningful.

**Every new binary distribution path requires a `looksLikeDevBuildExecutable()` audit.**
The function uses regex path matching. A new install path that accidentally matches
`/packages/myco-<arch>/bin/` would be misclassified as a dev build and blocked from
managing the prod service. Audit the function whenever a new binary path is introduced.

**The channel setting is machine-scoped, not per-project.**
`writeProjectReleaseChannel` is a misleading function name — it writes `daemon.update_channel`,
a machine-level setting (`{ home: 'machine', overridableBy: [] }` in config scope). One managed
binary at `~/.myco/bin/myco` per `MYCO_HOME`. The channel is not per-grove.

**UI: upgrade and channel toggle live on Settings, not Operations.**
The `<UpgradeCard/>` and the Stable/Beta channel toggle are on the **Settings page**
(`/settings` → Upgrade section). The Operations page hosts only database/file health
for the grove's SQLite store. When writing docs, reference "Settings page → Upgrade section."

**Service labels are per-home, not per-variant.** Never hardcode the prod service label
string for a non-default-home daemon. Always obtain it via `serviceLabel(mycoHome)`.
Hardcoding the prod label for a dev daemon causes `launchctl bootstrap` to clobber the
prod registration in the shared `gui/<uid>` domain.

**Code-signing binary swaps need re-verify + full re-bootstrap, not just `kickstart -k`.** `codesign -dv` only prints signature info — it does NOT verify the signature is valid; use `codesign --verify` to confirm validity before assuming a copied/dev binary will run under launchd. A signature-invalid binary is SIGKILLed by launchd in a crash loop. Both the newly swapped-in binary AND the already-installed binary can independently be invalidly signed — check and re-sign both. After re-signing, a plain `launchctl kickstart -k` may not be enough to recover; a full `launchctl bootout` + `launchctl bootstrap` re-registration may be required.

**Non-default home daemons never point their service unit at the managed binary.**
`defaultServiceExecutable()` returns `process.execPath` unconditionally for non-default
homes. Code that calls `managedBinaryPath()` and writes the result into a plist for a
dev/dogfood home is a bug — it would silently point the dogfood unit at the prod binary
after the prod binary is installed, violating home isolation.
