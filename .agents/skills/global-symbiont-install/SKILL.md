---
name: myco:global-symbiont-install
description: |
  Apply this skill when working on global symbiont installation, extending
  the global install model, adding new symbionts for global deployment, or
  debugging issues that touch multiple projects simultaneously — even if the
  user doesn't explicitly ask about the install model or its constraints.
  Covers six repeatable procedures: (1) eliminating legacy fallback code
  during migration, (2) scoping the Symbiont page UI to auto-detect plus
  per-project override only, (3) scheduling symbiont health checks against
  PowerManager state, (4) previewing blast radius before any global write,
  (5) enforcing walker grove-ownership filtering to prevent cross-grove
  mutations, and (6) running a dry-run validation before committing global
  installs. Also covers the invariant that the global model is canonical —
  fallbacks are traps, per-project config is the escape hatch.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Global Symbiont Install: Design Decisions and Hazard Disciplines

The global symbiont install model (introduced in PR #355) auto-registers all
detected symbionts into every project owned by the current grove. This makes
scope mutations wide by design — a single command can touch dozens of project
directories simultaneously. The three design decisions below define the model's
coherent shape; the three hazard disciplines prevent it from corrupting
unrelated projects.

## Prerequisites

- The grove walker and MYCO_HOME are initialized; the current grove's ownership
  list is available from the registry.
- You are operating inside an active, named grove — not an unbound bootstrap
  state (the daemon ensures this before surfacing any global-install UI).
- Project initialization has been migrated to the daemon UI. `myco init
  --project` no longer exists as a CLI command; do not attempt to restore it.

## Design Decision 1: No Legacy Fallback Code After Migration

When the migration walker has run, the configuration is global. Do not add
"if old config exists, use that" fallback paths.

**Why:** Legacy fallbacks compound into divergent code paths, exponential test
burden, and permanent production debt. From PR #355 code review (batch 5128):

> *"It's this class of bug that's continuously plagued us time and time again.
> We just squashed another one today with a Grove migration legacy fallback.
> So we know we're going to migrate it so let's not worry about the legacy
> fallback. I don't want that trap in the code."*

Three failure modes of keeping fallbacks:
1. The old path and new path handle the same scenario differently → regressions.
2. Every test must cover both paths → exponential test count.
3. The code lives forever; users who haven't migrated stay stuck on the old
   path indefinitely.

**Implementation pattern** (`packages/myco/src/symbionts/installer.ts`,
`packages/myco/src/cli/remove.ts`):

```typescript
// CORRECT — step 3 of migration walker, unconditional
await removeProjectLaunchers(projectRoot, { runtimeCommand: true });

// WRONG — legacy fallback trap
if (await hasLegacyConfig(projectDir)) {
  // use legacy path — do NOT do this
} else {
  await removeProjectLaunchers(projectRoot, { runtimeCommand: true });
}
```

The walker run is the canonical signal that migration is complete. No secondary
check is needed or wanted. The same rule applies to grove migration fallbacks —
any "if old grove config exists" path is a trap; remove it at the point the
walker commits.

**Post-migration hook command shape:** After the launcher-unification migration,
symbiont hook commands invoke the Myco binary directly (e.g., `myco hook
session-start --symbiont claude`) rather than via an intermediate launcher
script. Do not write new hook commands that reference the old shared launcher
file — that indirection has been retired across all platforms (Mac, Linux,
Windows).

## Design Decision 2: Symbiont Page UI — Auto-Detect and Per-Project Disable-Filter Only

The Symbiont page offers no install/uninstall controls. Instead:

1. **Auto-detection** — All detected symbionts are automatically wired globally
   into user agent configs.
2. **Per-project override (disable-filter only)** — The only project-level
   symbiont override that exists is the `symbionts:` **capture-filter**: a
   per-project list of symbionts to disable from collection/integration. There
   is no per-project install/uninstall toggle. The page surfaces this filter as
   project-scoped enable/disable chips.
3. **Config backing** — The disable-filter list writes to the per-project
   symbiont config (`.myco/myco.yaml`). This is the only per-project scope
   boundary remaining after global-install migration.

**Why:** No install/uninstall UI prevents users from encountering the
global-vs-project scope ambiguity. Global install is automatic; per-project
exceptions are the deliberate escape hatch. The page's affordance (a project
is already selected) makes project-scoped controls natural — global controls
don't fit.

**Scope boundary — Canopy injection:** Cursor, Antigravity, and OpenCode are
intentionally excluded from Canopy injection. All three lack a pre-tool
conversational-context injection slot in their hook contracts (they support
allow/deny/modify-args only, not `additionalContext`). Their manifests carry
`preToolUseInjection: false` (defined in
`packages/myco/src/symbionts/manifest-schema.ts`) and the Symbionts page chip
set reflects this automatically. Do not attempt to add Canopy to these three
agents; the exclusion is architectural, not a gap.

**Gotcha:** Don't surface global install/uninstall buttons anywhere on the
Symbiont page. If you're designing a new control, ask: "Is this a per-project
disable-filter override, or am I re-introducing a global install toggle?" Only
per-project disable-filter controls belong on this page.

## Design Decision 3: Health-Check Schedule Synced to PowerManager

Symbiont health checks must run more frequently than the update check but
synchronized with `PowerManager` state (active/sleep).

**What health checks validate (per R4.7):**
- Hook file existence and manifest consistency
- Plugin registry scan
- Hook matcher field presence
- `cd`-prefix env scoping for global hooks

**Why:**
- Update checks run at long intervals (daily or weekly). Symbiont health needs
  tighter feedback to catch hook-registration drift or config-file corruption.
- `PowerManager` already tracks daemon state. Syncing to it avoids expensive
  validation during sleep or low-battery states.
- The validation itself is cheap (file checks, not installs) — but this is
  not a reason to skip power-state gating.

**Constraint:** Exact frequency is deferred to plan/review. The invariant is:
more frequent than update check, less aggressive than per-daemon-tick, always
gated on `PowerManager` active state. Do not schedule a fixed wall-clock
interval without consulting the power manager.

## Hazard Discipline 1: Blast-Radius Preview Before Any Global Write

Global installs touch N projects simultaneously. Always enumerate scope before
committing writes.

**Procedure:**
1. Before triggering any global install or migration step, enumerate the full
   target set: which projects will be touched, which grove owns them.
2. Log or display the count and directory paths.
3. Verify the set matches expectation. If it includes projects outside the
   intended grove, stop and investigate ownership filtering (see Discipline 2).
4. Only after confirming scope does the write phase begin.

**Why atomicity matters:** The target directory list must be gathered **before**
the write phase starts. If you build the target list lazily during writes, a
failure mid-walk leaves projects in a mixed state — some migrated, some not.
Gather first, write all-or-nothing second.

**Gotcha:** A global install that touches 12 projects when you expected 3 will
corrupt 9 project directories. The blast radius is not visible from the install
command's name — you must look at the walker's scope output. Never skip the
preview step under time pressure.

## Hazard Discipline 2: Walker Grove Ownership Filtering Invariant

The grove walker must only process directories owned by the current grove. This
is not a best-effort check — it is a hard invariant.

**Why:** MYCO_HOME may contain directories from multiple groves. Without
ownership filtering, a global install command for Grove A writes into Grove B's
projects. Cross-grove mutation has no easy rollback.

**Implementation requirement:** Before the walker processes any directory:
1. Resolve the directory's grove owner from the registry or project manifest
   (see `groveId` resolution pattern in
   `packages/myco/src/symbionts/templates/opencode/plugin.ts`).
2. Compare against the current grove ID.
3. **Skip** (not error — skip) any directory that doesn't match.

**Greenfield vs. brownfield classification:**

| Classification | Definition | Walker action |
|---|---|---|
| Greenfield | No `.myco/` folder; not yet registered | Install — subject to gitignore preservation |
| Brownfield-own | Has `.myco/`; owned by current grove | Install per normal flow |
| Brownfield-foreign | Has `.myco/`; owned by different grove | **Skip unconditionally** |

Never install into a brownfield-foreign directory. The user must explicitly
transfer grove ownership before the walker will process it.

**Gotcha:** A directory that appears in MYCO_HOME is not automatically
owned by the active grove. The ownership check is always required; don't
short-circuit it based on path prefix alone.

## Hazard Discipline 3: Dry-Run Validation Before Committing

Before committing any global install, simulate it in dry-run mode and validate
that scope matches expectation.

**Procedure:**
1. Run the install command with `--dry-run` (or equivalent flag).
2. Review the output: which projects would be touched, which symbiont files
   would be written, which `.gitignore` entries would be appended.
3. Confirm no unexpected projects appear (cross-check with Disciplines 1 and 2).
4. Confirm no existing `.gitignore` entries are listed as modified (see
   Cross-Cutting Gotchas below).
5. If the dry-run output matches expectation, commit the real install.

**Why:** The dry-run output is the blast-radius preview. It costs nothing and
prevents multi-project corruption that is expensive to roll back manually.

**Gotcha:** Dry-run mode must apply the same grove ownership filter as the real
install. A dry-run that uses a looser filter than the real walker produces a
false-safe preview — the real run will skip directories the dry-run showed, or
vice versa. Verify the filter configuration is identical between modes.

## Cross-Cutting Gotchas

### Gitignore Preservation During Walker Traversal

The walker must never overwrite existing `.gitignore` entries during traversal.
Appending new entries is allowed; overwriting is not. Before any `.gitignore`
write, check whether the target entry already exists. If it does, skip the
write — do not re-write even if the content matches, because the user may have
modified the file since install.

### Project Initialization Is Daemon-Only

`myco init --project` has been removed (confirmed: `packages/myco/src/cli.ts`
prints `` `myco init` was removed in v0.26 ``). Project initialization (`.myco`
folder creation, asset provisioning) now happens exclusively through the daemon
UI. Do not attempt to restore a broken `.myco` folder via CLI — use the daemon
UI or manual intervention. This is deliberate: the daemon is the single
coordination point for project registration and sandbox setup, eliminating
CLI-only edge cases that diverge from the daemon-managed path.

### Shared Grove Vault Schema Hazard (Git Worktrees)

All git worktrees that share a repository's `git-common-dir` resolve to the
same Grove vault database. A schema migration, database write, or upgrade step
triggered in one worktree applies immediately to all sibling worktrees sharing
that Grove vault. This is intentional design but creates a hazard during
development: migrating the schema while another worktree's compiled binary
expects the old schema will break that binary immediately. Coordinate schema
migrations across all active worktrees before upgrading any single one.

### Fresh-Worktree Dev-Binary Pin Not Inherited

The per-worktree dev binary pin file is gitignored and is **not inherited** by
new git worktrees. When you create a fresh worktree via `git worktree add`, any
existing dev binary pin does not transfer. The new worktree falls back to the
globally-installed `myco` binary. If the worktree requires a pinned dev build,
re-run `make dev-link` (or manually set the pin) in the new worktree before
running any hooks.

### Documentation Discipline — Three-Surface Rule

When documenting global symbiont install behavior, apply the three-surface rule
(from PR #355 documentation finalization, commit `d3d38158`):

1. **AGENTS.md** — durable invariants only (e.g., "project registration is
   automatic on first agent hook"). No implementation details, no fallback
   explanations.
2. **Source comments** — HOW the mechanism works (for maintainers debugging
   code). No why-rationale.
3. **Vault decisions / spores** — full rationale: WHAT, WHY, WHAT changed,
   trade-off analysis.

Do not expose internal fallback terminology (`_unbound-bootstrap/`,
"phantom vault") in user-facing docs. Users' mental model is:
*install → default Grove auto-created → first hook fires → project registered*.
Everything else is implementation noise that adds confusion without value.

### toolTransport Manifest Field Drives Installer Hook-Command Seam

The `toolTransport` field in `SymbiontCapabilities`
(`packages/myco/src/symbionts/manifest-schema.ts`, default `'mcp'`) declares
whether a symbiont accesses Myco tools via MCP transport or CLI transport. This
field directly gates the installer's hook-command generation: MCP-transport
symbionts get one hook command shape; CLI-transport symbionts get another. When
adding a new symbiont, set `toolTransport` correctly in the manifest **before**
wiring up the installer — an incorrect value silently produces a hook command
that cannot invoke Myco tools at runtime. The runtime resolver lives in
`packages/myco/src/symbionts/capabilities.ts`.

### assertSafeProjectRoot Required Before Any Project-Root Cleanup

`assertSafeProjectRoot(projectRoot)` (exported from
`packages/myco/src/vault/resolve.ts`) must be called before any cleanup or
write operation that targets a project root directory. It rejects unsafe paths
(e.g., `~/.myco`, system directories, the grove root itself) that would cause
catastrophic cross-project damage if written to during a global install walk.
Already used in `packages/myco/src/cli/remove.ts` and
`packages/myco/src/grove/registry.ts`. Do not bypass it with ad-hoc path
checks — the function covers edge cases that manual checks miss.

### myco update Skips Re-Install When Content Matches Template

When a symbiont's installed hook file content matches the current template
byte-for-byte, `myco update` treats the installation as up-to-date and skips
it. If a bug existed in both the template and the installer simultaneously, a
template-only fix will not propagate to projects whose hook files already match
the (buggy) template output — the update pass sees identical content and skips
them. After fixing a template bug, verify that installed hook files don't
already match the old buggy template; if they do, a manual force-reinstall is
required to push the fix.

### Launcher Retirement: Delete-Last Migration Ordering

When retiring the shared global launcher files from `~/.myco/`, the deletion
must happen **after** all per-project symbiont hook configs have been rewritten
to use direct binary invocation. `installHookGuard()` in
`packages/myco/src/symbionts/installer.ts:593` explicitly defers this deletion.
Deleting the shared launcher before rewriting symbiont configs creates a
capture-loss window where hook processes still reference the now-missing
launcher. The correct order is:

1. Rewrite all per-project symbiont hook commands to direct binary form.
2. Verify all rewrites committed successfully.
3. Delete the shared global launcher files.

### Legacy `.agents/` Stub Cleanup in Brownfield Projects

The global-install migration must also remove pre-1.0.0 legacy launcher stubs
from brownfield projects. These stubs (detectable by their "Managed by Myco"
header comment) are NOT automatically removed by the new install walker — they
require an explicit cleanup pass. The migration in
`packages/myco/src/grove/global-config-migration.ts` targets these stubs for
removal. Without this cleanup, brownfield projects accumulate stale committed
artifacts that confuse the "is Myco-owned?" ownership predicate. Run the cleanup
pass as part of the same migration step that rewrites hook commands.

### Cross-Variant Global-Artifact Thrash (Prod + Dev Daemons)

When a production daemon and a dogfood dev daemon run concurrently on the same
machine, both variants may run the same power jobs that call
`runSymbiontDetection()` (in `packages/myco/src/cli/bootstrap.ts`) against the
same machine-global targets (global agent config files, shared hook registrations).
This creates a thrash where each variant overwrites the other's changes on every
power-job cycle. The fix is variant-scoped claim transfer or skip logic: the dev
daemon must not overwrite machine-global artifacts owned by the prod daemon
variant, or must transfer the subsystem claim before writing. Never assume a
global write by the dev daemon is safe when prod is also active.
