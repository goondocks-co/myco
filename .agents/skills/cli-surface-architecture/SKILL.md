---
name: myco:cli-surface-architecture
description: "Use this skill when working on Myco's CLI command surface: deciding whether a feature belongs in CLI or UI, adding or changing myco doctor checks, removing a CLI command from the codebase, understanding runtime.command semantics, or managing beta channel logic. Triggers on: new CLI command proposals, doctor scope questions, myco init references, runtime.command usage, beta channel switching, or ensureSelfInstalledAsService changes."
display_name: Myco CLI Surface Architecture
managed_by: myco
user-invocable: false
allowed-tools: Read, Grep, Glob
---

# Myco CLI Surface Architecture

Myco applies a **UI-first philosophy** to its command surface: CLI handles
installation, teardown, and one-time diagnostics; UI handles all ongoing
configuration and management. `myco init` was the last command that straddled
both categories — its removal in the `global-symbiont-install` branch completed
the separation. Every future CLI change must pass through the same gate.

## 1. CLI vs UI Responsibility Assignment

When a feature could be a CLI command, apply this gate before building it:

> **"Can this be done without the daemon running?"**
> - Yes → CLI is appropriate (install, remove, diagnose, repair).
> - No (requires ongoing daemon state, per-project config, or discovery) → belongs in UI.

**Decision table:**

| Task | Destination | Why |
|------|-------------|-----|
| Install global binary + register service | CLI (`myco install`) | One-time, no daemon needed |
| Tear down global install | CLI (`myco remove`, `packages/myco/src/cli/remove.ts`) | One-time, daemon is being stopped |
| Check vault health | CLI (`myco doctor`, `packages/myco/src/cli/doctor.ts`) | Diagnostic, runs before daemon is healthy |
| Re-detect newly installed agents | UI ("Re-detect now" button) | Requires running daemon + project context |
| Override symbiont config per project | UI (Symbionts page) | Ongoing management, not a setup step |
| Drain brownfield-cleanup queue | Daemon auto-path | Daemon handles automatically; UI if manual retry needed |

**Worked example — agent re-detection:**
Old: `myco init --project` triggered agent detection.
New: Detection is a daemon background operation. The "Re-detect now" button on
the Symbionts page is the correct affordance — it calls into a running daemon.

**Worked example — brownfield queue drain:**
- Old doctor message: *"Run `myco init` to drain the queue."*
- Correct replacement: *"The daemon will clean these up automatically; restart to trigger immediately."*

## 2. `myco doctor` Scope Invariants

`doctor` is the install-and-diagnostic surface only. Its scope is a **maintained
invariant** — new additions must pass the same CLI vs UI gate from §1.

**Permitted scope (`packages/myco/src/cli/doctor.ts`):**
- Verify global Myco installation and daemon state
- Report symbiont detection status per project
- Check provider, embeddings, and LLM configuration presence
- Report migration status and brownfield-cleanup state
- Offer `--fix` to re-run bootstrap or repair fixable issues (rewrite malformed
  hooks, add missing `matcher` fields, etc.)

**Prohibited scope (redirected to UI):**
- Manage per-project symbiont overrides → Symbionts page
- Re-detect agents → "Re-detect now" UI button
- Trigger brownfield queue drain → daemon auto-path
- Any operation that requires a healthy running daemon to succeed

**Canonical message replacements for removed `myco init` references:**

| Old doctor message | Replacement |
|--------------------|-------------|
| "Run `myco init` to drain the queue." | "The daemon will clean these up automatically; restart to trigger immediately." |
| "Run `myco init --project <path>` for project config." | Point to Symbionts page in UI |
| "Run `myco init` to re-detect agents." | Remove; re-detection is a UI button |

**Acceptance gate for new doctor additions:**
1. Does the check require a running daemon to produce a meaningful result? If yes → not a doctor check.
2. Is the fix an ongoing management task rather than a one-time repair? Ongoing → UI.
3. Does `--fix` make the system self-consistent without daemon participation? If not → fix belongs elsewhere.

## 3. Command Removal Procedure

`myco init` removal is the canonical model. Follow these five steps when
removing a CLI command:

**Step 1 — Audit all callers and tests.**
Search for the command's entry point (e.g., the now-removed
`packages/myco/src/cli/init.ts`), all `import`/`require` references, and all
test files that exercise it. Confirm no user-facing path still depends on it.

**Step 2 — Verify the replacement is in place.**
Before removing the trigger, confirm the replacement affordance exists and works
(UI button, daemon auto-path, or another command). Do not remove a command while
users still need it.

**Step 3 — Remove the entry point and registration.**
Delete the source file and remove the command registration from the CLI
dispatcher. This step may resolve latent bugs as a side effect — see the BUG-4
gotcha below.

**Step 4 — Update `doctor.ts` messages.**
Scan `packages/myco/src/cli/doctor.ts` for any `--fix` paths or user-facing
strings that reference the removed command. Apply the canonical replacements from §2.

**Step 5 — Confirm the replacement via smoke test.**
Walk the user journey that the removed command previously served and confirm the
new path (UI or daemon) handles it correctly.

> **Gotcha — BUG-4 side effect (init removal):**
> `myco init` triggered `ensureSelfInstalledAsService`
> (exported from `packages/myco/src/service/self-install.ts`). That function
> read from process-wide path constants instead of `MYCO_HOME`, causing a
> sandbox LaunchAgent hijack when init ran inside a sandboxed process. Removing
> the init trigger eliminated this bug. When removing a command, check whether
> it was the sole trigger for any path into `service/self-install.ts` or
> `service/spec-builder.ts` — removing the trigger may be the cleanest fix.
>
> After init removal, the only remaining caller of `ensureSelfInstalledAsService`
> is `packages/myco/src/daemon/main.ts`. Do not call it from new CLI commands.

## 4. `runtime.command` Configuration Semantics

`.myco/runtime.command` is a **user-facing opt-in config file**, not a CLI
artifact. Getting this wrong corrupts the remove/install contract.

**What install writes (and remove must clean up):**
- `.agents/myco-run.cjs` — the hook guard (template key `"myco-run.cjs"` in
  `packages/myco/src/symbionts/templates.generated.ts`)
- `.agents/myco-cli.cjs` — the CLI shim
- Per-agent project-local config files
- `.myco/myco.yaml` — symbionts block

**What `myco remove` must NOT touch:**
- `.myco/runtime.command` — never written by install, never owned by remove

**What `runtime.command` is used for:**
- **Dogfooding:** developers set `.myco/runtime.command` to a local build path
  via `make dev-link`; this pins the binary for a specific project without
  affecting others. Not written by any CLI command.
- **Machine-scope beta pin:** `~/.myco/runtime.command` is written by the
  beta-channel installer. It is the machine-wide fallback when no project pin
  exists.

**Layered resolution order** (implemented in `resolveRuntimeCommand` in
`packages/myco/src/daemon/update-checker.ts`):
1. `<vaultDir>/runtime.command` — project-scope pin (checked first)
2. `~/.myco/runtime.command` — machine-scope pin (fallback)
3. Implicit PATH-resolved `myco` binary (no file present)

**Rule for future commands:** Any command that manages project artifacts must
explicitly enumerate what it writes. `runtime.command` must never appear on that
list — it is not install-written and must not be remove-cleaned.

## 5. Beta Channel Global Replace Strategy

Under the global-install architecture, beta switching is **system-wide**. There
is no per-project beta toggle.

**Why global-only:**
- The daemon is a system service, not a per-project process. Per-project beta
  would require coordinating multiple independent daemons and binaries.
- Global replacement is atomic: one command, one outcome.
- The `runtimeScope` field (`'machine'` vs `'managed'`) in
  `packages/myco/src/daemon/api/update.ts` distinguishes whether the current
  binary is the PATH-resolved global install or the managed beta runtime under
  `~/.myco/runtime/`.

**Beta channel entry — implementation path:**
1. Daemon API detects `status.channel === 'beta'` and `snapshot.runtimeScope === 'machine'`.
2. Sets `localRuntimeSpec` to the beta package spec.
3. `spawnUpdateScript` installs the beta package to `~/.myco/runtime/` and writes
   `~/.myco/runtime.command` pointing to it.
4. Service restarts against the new binary.

**Rollback procedure (beta → stable):**
1. Change channel to `'stable'` via the UI or config.
2. Daemon detects `removeLocalRuntime = true` (`status.channel === 'stable'` and
   `snapshot.runtimeScope === 'managed'`).
3. Update script removes `~/.myco/runtime/` and clears `~/.myco/runtime.command`.
4. Service restarts against the PATH-resolved stable binary.
5. This is a **system-wide** downgrade — all projects revert simultaneously.

**Critical distinction — `runtime.command` is not a channel toggle:**
Writing `.myco/runtime.command` pins the binary path; it does not change the
update channel. The channel lives in `local.yaml` under the `update_channel`
field (`packages/myco/src/config/schema.ts`). A mismatched state (e.g.,
`channel: stable` but `runtime.command` pointing to a beta binary) causes
the update checker to behave unexpectedly. Always update both when manually
intervening.

## Cross-Cutting Gotchas

- **`myco init` is gone.** `packages/myco/src/cli/init.ts` no longer exists.
  Any reference to `myco init` in docs, doctor messages, or code comments must
  be replaced per the table in §2.

- **`myco remove` owns the install artifact list** (`packages/myco/src/cli/remove.ts`).
  Any new file that install creates must be explicitly added to the remove
  cleanup list. `runtime.command` is never on this list.

- **`ensureSelfInstalledAsService` is daemon-only.** Its sole remaining caller
  is `packages/myco/src/daemon/main.ts`. Do not introduce new CLI callers — the
  process-wide path constant issue (BUG-4) is not fully resolved in non-daemon
  contexts.

- **Doctor `--fix` must be daemon-optional.** Any `--fix` path added to
  `packages/myco/src/cli/doctor.ts` must work when the daemon is not running.
  If the fix requires daemon participation, it is not a doctor fix.
