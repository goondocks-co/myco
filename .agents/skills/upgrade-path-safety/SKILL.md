---
name: myco:upgrade-path-safety
description: |
  Apply this skill when validating, testing, or releasing any version-to-version
  upgrade — even if the user doesn't explicitly ask about upgrade safety. Covers
  five orthogonal procedures: (1) clean-state revert methodology before upgrade
  testing to simulate real-world conditions; (2) CI-as-primary-gate discipline
  when local tests are flaky or environment-contaminated; (3) merge→publish→test
  release sequencing to avoid blocking on local reliability; (4) detecting and
  handling the self-propagation trap, where a bug disables the auto-adopt
  mechanism that would deliver its own fix; (5) dev environment routing via
  pattern extension (runtime.command + runtime.home + manual channel) instead
  of bespoke knobs.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Upgrade Path Safety Profile

This skill governs the discipline around validating and releasing version-to-version
upgrades in the Myco native installer (e.g., v1.1.2 → v1.2.0). The procedures were
established under real conditions during the `feat/native-installer` branch and apply
to any upgrade cycle involving binary replacement, installer mechanics, or auto-adopt
channels.

Use this skill whenever you are: testing an upgrade path, cutting a release beta,
debugging auto-adopt failures, or designing dev environment routing for dual-daemon
setups.

## Prerequisites

Before any upgrade-path work:

- Know the **source version** (prior release) users will be upgrading from.
- Know the **target channel** (`beta`, `stable`, or `manual`) for the upgrade.
- Have a clean machine state available — or be prepared to revert to one. A
  development state with partial changes applied is **not** a valid starting point
  for upgrade testing.
- CI must be available and healthy. If CI is down, all validation gates collapse.

## Procedure A: Clean-State Revert Before Upgrade Testing

**Why:** Testing an upgrade from a mid-development state doesn't simulate real user
conditions. Only a clean install of the prior release exercises the actual code path
users will hit.

**Steps:**

1. **Fully revert** to a clean install of the prior release — uninstall the current
   binary, clear `MYCO_HOME`, and reinstall as if you were a fresh user:
   ```bash
   # Remove current install
   rm -rf ~/.myco/bin/myco
   # Reinstall prior release (e.g., 1.1.2) from the release artifact
   ```
2. **Set the channel** to match the target in `~/.myco/config.yaml`:
   ```yaml
   daemon:
     update_channel: beta   # or stable
   ```
3. **Run the upgrade** from that clean state — do not shortcut by applying dev
   changes before running the upgrade command.

**Rationale:** "That is our best way to test this as it would be in the wild."
(session 7bf0bb2d, batch 9620). Testing from an in-dev state introduces artefacts —
leftover processes, partial file states, contaminated `MYCO_HOME` — that real users
never have.

**Gotcha — launchd KeepAlive:** After a revert, `launchd` may hold port 20915
because the old plist has `KeepAlive: true`. This is an environment hygiene issue,
not a code bug. Check `launchctl list | grep myco` and unload the old plist before
declaring the revert complete.

## Procedure B: CI as Primary Validation Gate

**Why:** When local tests are flaky during upgrade-path work, CI on a clean machine
is a better proxy for real-user behavior than your contaminated local environment.
Local flakiness reflects environment state, not code bugs.

**Steps:**

1. **Diagnose why local tests are unreliable.** Common causes during upgrade work:
   - Dev daemon over-capturing prompts (test output contaminated by side-effects)
   - Repeated revert/upgrade cycles leaving stale process state
   - `launchd` holding ports or keeping the prior binary alive
2. **Push to CI rather than blocking** — open the PR and let CI run on a clean
   environment. Do not wait to fix local infrastructure first.
3. **Treat CI green as the merge gate**, not local green.
4. **Log the local reliability issue** as a follow-up, not a blocker.

**Rationale:** "The real goal is to get the upgrade from 1.1.2 to 1.2.0 working
correctly. If the tests can't run locally reliably, that is an issue we have to
solve, but that is secondary." (session 7bf0bb2d, batch 9674).

**Caveat:** This is about sequencing, not abandonment. Local test reliability still
needs a follow-up — it signals real environment hygiene issues (e.g., launchd
KeepAlive holding ports across reverts). The prioritization is: fix the upgrade path
first, then stabilize the local test harness.

## Procedure C: Release Sequencing — Merge → Publish → Test

**Why:** Blocking a merge on local test reliability inverts the priority. The shipped
artifact's behavior on a clean machine is what matters, and you can't test that until
you publish.

**Correct sequence:**

1. **Merge the PR** — CI green is the authoritative gate (see Procedure B).
2. **Cut and publish the beta** — make the artifact available on the target channel.
3. **Test locally once it lands** — verify against the published artifact using a
   clean-state revert (see Procedure A), not against the dev build.

**Anti-pattern — do not do this:**
- Block the merge waiting for local tests to pass when CI is green
- Test the upgrade path against your in-dev binary before publishing
- Conflate "local test green" with "upgrade path correct"

**Example outcome (beta.4, v1.1.2→v1.2.0):** After merge and publish, testing
against the published artifact confirmed end-to-end: convergence layout correct,
`.myco/.myco` absent, `MYCO_HOME` honored, `~/.myco/bin/myco` byte-identical
before/after upgrade.

## Procedure D: Self-Propagation Trap — Manual Bootstrap for Bug Fixes

**Why:** Some bugs disable the very mechanism that would deliver their own fix. When
a daemon is incorrectly marked as `update_exempt` (e.g., due to a dev-build
detection bug), that daemon cannot auto-adopt the fix — the channel the fix travels
through is the one the bug broke.

**Detection checklist — you have a self-propagation trap if:**
- [ ] The bug affects auto-adopt, auto-check, or `update_channel` evaluation
- [ ] The fix ships via the same channel the bug disables
- [ ] Users are already running a version with the bug installed

**Handling steps:**

1. **Identify the affected version range** — e.g., beta.5 and beta.6 users are stuck.
2. **Publish a fix build** (e.g., beta.7) containing the repair.
3. **Require a manual installer hop** — affected users must manually run the
   installer to reach the fix build. There is no self-healing path.
4. **Cut a new adopt-target beta after the fix** — because the fix build (beta.7) is
   now the highest-numbered beta, you must publish a new beta (e.g., beta.8) as the
   auto-adopt target. Users on beta.7 will then auto-adopt beta.8 normally.
5. **Confirm dev-build detection re-evaluates** — a version bump to the fix build
   changes the version key used for dev-build detection, so any previously cached
   stale verdict is invalidated on first run. No manual cache clear is needed in
   the field.

**Beta rollout sequencing example (dev-build detection fix):**
```
beta.5/beta.6  → affected (update_exempt bug present; cannot self-upgrade)
beta.7         → fix build (requires manual installer hop from beta.5/beta.6)
beta.8         → new auto-adopt target (cut after beta.7 lands; normal auto-adopt resumes)
```

**GA gate rule:** Any bug that creates a self-propagation trap **must** be fixed
before GA. A GA release with this bug means every native install reaches steady state
(`launchd` plist self-heals → daemon at `~/.myco/bin/myco`) and becomes permanently
unable to self-upgrade. The only recovery is a full manual reinstall.

> "Good that the dogfood test caught it in beta."

## Procedure E: Dev Environment Routing via Pattern Extension

**Why:** Bespoke machine-specific knobs (e.g., a `MYCO_DEV_HOME` env var that only
exists on the dogfood machine) cause churn, break dogfooding, and codify something
that can never ship to users. Instead, extend the two general-purpose mechanisms
already in place.

### Mechanism 1: Two-file pin — `runtime.command` + `runtime.home`

`make dev-link` writes two companion files in `<repo>/.myco/`:

```
# <repo>/.myco/runtime.command  (binary path — one line, absolute)
~/.local/bin/myco-dev

# <repo>/.myco/runtime.home  (MYCO_HOME companion — one line, absolute)
~/.myco-dev
```

`myco-run.cjs` (the hook/MCP launcher shim) reads `runtime.command` for the binary
and `runtime.home` beside it for the MYCO_HOME override. Together they route all
in-repo launchers to both the dev binary **and** the dev home in a single
`make dev-link` invocation. The home (`~/.myco-dev`) determines `bin/`, `groves/`,
`service/`, and the daemon port.

The `myco-dev` wrapper at `~/.local/bin/myco-dev` sets `MYCO_HOME=~/.myco-dev` and
`MYCO_CLAIMS_HOME=~/.myco` before executing `~/.myco-dev/bin/myco`. This is what
`runtime.command` points to.

### Mechanism 2: `manual` channel in `~/.myco-dev/config.yaml`

The `daemon.update_channel` enum extends from `stable | beta` to
`stable | beta | manual`. `manual` means: never auto-check or auto-adopt; explicit
`myco upgrade` still works.

```yaml
# ~/.myco-dev/config.yaml
daemon:
  update_channel: manual
```

`make dev-link` writes this value (only if the file doesn't exist, to preserve
contributor edits) so the dev daemon never self-upgrades and never interferes with
upgrade-path testing cycles.

**Why `manual` is a real product feature, not a hack:** It's designed as a
"pin my version" option for users who don't want automatic updates. Shipping it as a
general feature means it's testable, maintainable, and beneficial to real users —
not invisible debt on the dogfood machine.

**Anti-pattern:**
```
# Don't do this — bespoke knob that can never ship
if os.Getenv("MYCO_DEV_HOME") != "" {
    homeDir = os.Getenv("MYCO_DEV_HOME")
}
```

This pattern "makes it near impossible to dogfood what should be a straightforward
thing" because you can't reproduce it on any machine that doesn't have the magic env
var set.

## Cross-Cutting Gotchas

- **Dev build ≠ published artifact for upgrade testing.** These are different test
  subjects. The dev binary may have side-effects (over-capture, partial states) the
  published artifact doesn't. Final upgrade validation must always be against the
  published artifact (Procedures A + C together).

- **Version ordering is numeric.** Beta version numbers compare numerically, not
  lexicographically. If the fix lands in beta.7, you cannot re-use beta.6 as the
  auto-adopt target — you must cut beta.8 (Procedure D, step 4).

- **Use `MYCO_HOME` isolation, not `MYCO_SERVICE_VARIANT`.** The current architecture
  isolates dev and prod via separate home directories (`~/.myco` for prod,
  `~/.myco-dev` for dev). `MYCO_SERVICE_VARIANT` was removed — AGENTS.md explicitly
  states "There is no `MYCO_SERVICE_VARIANT`". Do not add code that branches on
  that variable; use `MYCO_HOME` scoping instead.

- **Revert completeness check.** A "clean revert" is not complete until: old binary
  is removed, `MYCO_HOME` is in expected initial state, and the launchd plist for
  the old version is unloaded. Missing any of these leaves ghost state that
  contaminates the upgrade test.

- **CI environment is authoritative for upgrade path, not local.** This is a design
  principle, not a workaround. Upgrade-path correctness is defined by behavior on a
  clean machine — exactly what CI provides.

- **Beta-tag deletion downgrade trap.** The beta channel resolves to
  `max(latest_stable, latest_prerelease)` — both the curl installer (`docs/install.sh`)
  and the daemon's channel resolution use this logic. Deleting pre-release tags
  BEFORE the GA stable tag exists causes every beta-channel user to downgrade to the
  previous stable version. Always verify that `myco/v<GA>` is published and resolving
  correctly on the beta channel before removing any pre-release tags or GitHub releases.
