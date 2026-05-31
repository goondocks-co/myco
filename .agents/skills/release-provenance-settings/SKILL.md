---
name: myco:release-provenance-settings
description: |
  Use this skill when configuring or auditing Myco's release provenance settings —
  even if the user doesn't explicitly ask about the full setup. Covers five
  procedures: (1) selecting a release provenance preset and setting
  productionRef/integrationRef; (2) configuring the GitHub token as a
  machine-scoped-only credential (never per-Grove); (3) configuring monorepo
  package-to-tag mapping; (4) auditing or fixing config route scope isolation in
  daemon code (the `req.requestContext?.projectVaultDir ?? bootstrapVaultDir`
  invariant); (5) navigating the Settings UI by feature flow (Release Model →
  GitHub Evidence → Reconciliation Behavior → Advanced). The scope isolation
  pattern is an ongoing architectural invariant — any config route author must
  apply it.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Release Provenance Settings Configuration and Lifecycle

Myco's release provenance system tracks which commits are included in each release by comparing Git refs. Configuring it correctly requires touching three layers: the ref settings (what counts as a release boundary), the GitHub credential (how Myco authenticates to enrich commit data), and the daemon config routes (how settings are scoped per-project). This skill covers the full configuration lifecycle.

**Scope boundary:** This skill covers the *settings/configuration* side of release provenance. For the Git snapshot capture algorithm and the two-tier reconciliation logic, see `myco:git-release-provenance-reconciler`.

---

## Prerequisites

- You understand Myco's three-tier config model (project, machine, Grove). See `myco:three-tier-config-architecture` if not.
- The target Grove or project is already registered in the daemon.
- For monorepo mapping: you know the package directories and the Git tag naming convention used for each package.
- For config route work: you are working in `packages/myco/src/daemon/` and understand that `req.requestContext` carries per-request vault scoping.

---

## Procedure A: Select a Release Provenance Preset and Configure Refs

Release provenance is defined by two Git refs — `productionRef` (marks shipped releases) and `integrationRef` (marks the integration branch, e.g., main). Standard presets pre-fill both:

| Preset | productionRef | integrationRef |
|---|---|---|
| `tag-based` | `refs/tags/v*` | `refs/heads/main` |
| `branch-based` | `refs/heads/release/*` | `refs/heads/main` |
| `custom` | user-defined | user-defined |

**Steps:**

1. Open **Settings → Release Model** in the Myco UI.
2. Select the preset that matches your project's tagging/branching strategy.
   - For monorepos with per-package tags, select `custom` — you will configure package mapping separately (Procedure C).
3. If using `custom`, fill in `productionRef` and `integrationRef` directly. Use full ref paths (`refs/tags/...`, `refs/heads/...`), not short names.
4. Save. Settings auto-save on blur for non-credential fields.
5. Verify in **Settings → Reconciliation Behavior** that reconciliation is enabled and the interval is set to a reasonable value (default: 60 minutes).

**Gotcha:** Presets are convenience shortcuts, not enforced constraints. Choosing `tag-based` does not validate that your repository actually uses `refs/tags/v*`. If your tags use a different naming pattern (e.g., `refs/tags/release-v*`), select `custom` and specify the correct glob.

---

## Procedure B: Set Up the GitHub Token (Machine-Scoped Only)

Myco uses a GitHub personal access token to enrich commit data (PR lookups, author metadata). This token is **always machine-scoped** — one identity per developer machine, shared across all Groves the daemon manages.

**Why machine-scoped only:** The daemon runs once per machine. A GitHub identity is a per-developer credential, not a per-project one. Unlike team API keys (which vary by Grove) or nothing, one developer → one GitHub identity.

Provider secret scope reference for clarity:

| Secret | Scope | Reason |
|---|---|---|
| `MYCO_TEAM_API_KEY` / `MYCO_TEAM_MCP_TOKEN` | Grove | Different Grove = different team |
| `MYCO_OPENAI_API_KEY` / `MYCO_OPENROUTER_API_KEY` | Machine | One provider per dev machine |
| `GITHUB_TOKEN` | **Machine** | One GitHub identity per machine |

**Steps:**

1. Open **Settings → GitHub Evidence**.
2. Enter your GitHub personal access token in the "Access token" field. The scope badge is fixed to `Machine` — this is intentional, not a UI bug.
3. Click **Connect** (first time) or **Update** (rotation). Machine secrets use an explicit save action, not auto-save on blur.
4. The daemon loads the token at startup with this precedence: legacy project-scoped token → machine-scoped token. Grove-scoped lookup is intentionally skipped for `GITHUB_TOKEN`.

**Do not** add a Grove-scoped `GITHUB_TOKEN` entry — the daemon will never read it for this credential. If you need per-Grove GitHub identities in the future, that is an architectural change, not a config workaround.

**Files involved:**
- `packages/myco/src/daemon/api/provider-secrets.ts` — token storage and retrieval
- `packages/myco/ui/src/hooks/use-provider-secrets.ts` — UI hook (scope badge logic)
- `packages/myco/ui/src/pages/Settings.tsx` — field rendering

---

## Procedure C: Configure Monorepo Package-to-Tag Mapping

For repositories with multiple independently-released packages, each package needs its own tag pattern so Myco can attribute releases correctly.

**Steps:**

1. Open **Settings → Advanced: Monorepo Releases**.
2. Add one entry per package:
   - **Package path** — relative path from repo root, e.g., `packages/myco`
   - **Tag pattern** — glob matching that package's version tags, e.g., `refs/tags/myco/v*`
3. Repeat for each package. Order does not matter — Myco resolves the most specific match.
4. Save (auto-save on blur).

**Example mapping for a two-package monorepo:**

```
packages/myco      → refs/tags/myco/v*
packages/myco-cli  → refs/tags/myco-cli/v*
```

**When to use this:** If `productionRef` in Procedure A is set to `refs/tags/v*` but your repo uses per-package tag prefixes, the global ref will miss most releases. Always add package mapping when tags are prefixed by package name.

**Gotcha:** If a commit is tagged by multiple package patterns, Myco uses the longest (most specific) package path match. Ensure patterns don't overlap ambiguously.

---

## Procedure D: Audit or Fix Config Route Scope Isolation

Every config route handler that reads or writes project-scoped settings **must** use the project-vault-first fallback pattern:

```ts
// Correct pattern — used in register-config-routes.ts via vaultDirFor(req):
req.requestContext?.projectVaultDir ?? bootstrapVaultDir
```

Using `bootstrapVaultDir` directly in a per-request handler causes all projects to share the first-configured project's settings — a cross-project data leak.

**How to audit existing routes:**

```bash
# Find all places bootstrapVaultDir appears in config-handling files
grep -n "bootstrapVaultDir" \
  packages/myco/src/daemon/api/register-config-routes.ts \
  packages/myco/src/daemon/main.ts
```

**Legitimate uses of bare `bootstrapVaultDir`** (daemon-level scope, not per-request):
- Agent/task registration (`registerBuiltInAgentsAndTasks`)
- Stale `agent_runs` cleanup queries
- `PowerManager` construction
- `ProjectPowerStateTracker` construction
- Daemon-startup config reconciliation

These are **correct** — they operate at daemon scope, not per-request. Do not change them.

**Incorrect uses** (any per-request handler reading/writing release provenance, merged config, or other project settings):

```ts
// Wrong — leaks across projects:
handleGetMergedConfig(bootstrapVaultDir, { groveId: req.requestContext?.groveId ?? null })

// Correct:
handleGetMergedConfig(req.requestContext?.projectVaultDir ?? bootstrapVaultDir, {
  groveId: req.requestContext?.groveId ?? null,
})
```

**Steps to fix a mis-scoped route:**

1. Locate the handler in `packages/myco/src/daemon/api/register-config-routes.ts`.
2. Replace `bootstrapVaultDir` with `req.requestContext?.projectVaultDir ?? bootstrapVaultDir` (or use the existing `vaultDirFor(req)` helper if it's already imported).
3. Ensure `applyConfigWriteReactions` receives `{ vaultDir, groveId }` scope rather than bare `bootstrapVaultDir`.
4. Add or extend the regression test at `tests/daemon/api/config-routes-per-request-vault.test.ts` — seed two project vaults with distinct `release_provenance` values, assert isolated reads, and assert that PUT to project B does not mutate project A's config.

**Gotcha — speculative fixes from stale line numbers:** Code review comments sometimes cite specific line numbers in `main.ts` (e.g., 910, 917–919, 992–994) as suspected mis-threading sites. Before changing anything, verify: (a) that the lines are in a per-request handler, not a daemon-level call; (b) that the actual config routes (in `register-config-routes.ts`) don't already use `vaultDirFor(req)`. The phantom-bug pattern — fixing lines that are legitimately daemon-scoped — has occurred before. Always reproduce the symptom ("wrong project's settings returned for a given `x-myco-grove-id`") before editing.

---

## Procedure E: Navigate the Settings UI by Feature Flow

The Settings page is organized around the *user's feature flow*, not implementation groupings. Use this map when helping a user find or understand a setting:

| Section | What it covers |
|---|---|
| **Release Model** | Presets, `productionRef`, `integrationRef` |
| **GitHub Evidence** | Repository URL, access token (machine-scoped), PR lookup budget |
| **Reconciliation Behavior** | Enable/disable, interval, unknown-commit handling |
| **Advanced: Monorepo Releases** | Package-to-tag mapping |

**UX conventions to be aware of:**
- Non-credential fields (refs, interval, repo URL) → **auto-save on blur**
- Machine-scoped secrets (GitHub token) → **explicit "Connect"/"Update" action** (write-only, value never echoed back)
- Labels use verb-noun style: "Access token" with action "Connect", not "GitHub API Key" with action "Save"
- Scope badges (e.g., `Machine`) are informational only — users cannot change scope in the UI

When a user reports that a setting "didn't save," first check whether the field is a machine secret (requires explicit action) vs. a regular field (saves on blur). If a setting appears correct in the UI but the reconciler ignores it, check Procedure D — the route may be returning another project's config.
