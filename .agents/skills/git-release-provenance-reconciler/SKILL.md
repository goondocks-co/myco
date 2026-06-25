---
name: myco:git-release-provenance-reconciler
description: Implement and maintain Git-based release provenance tracking with reconciliation for squash-merge workflows. Covers Git snapshot capture, two-tier reconciliation strategy (ancestry + patch-ID matching), knowledge graph propagation, performance optimization, and privacy-aware sync design. Use this for setting up release provenance systems, troubleshooting reconciliation issues, or maintaining Git lineage tracking even if the user doesn't explicitly ask for release provenance configuration.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Git Release Provenance Reconciler

A comprehensive system for tracking Git lineage and release state in squash-heavy workflows. This skill covers the complete lifecycle from initial configuration through ongoing maintenance of Git-aware release provenance tracking.

## Prerequisites

- Working Git repository with release tags and integration branches
- Understanding of squash-merge workflows and their impact on commit ancestry  
- Access to Git subprocesses and ability to parse `git for-each-ref`, `git show`, and patch-ID commands
- Database schema support for release state tracking and knowledge graph propagation

## Procedure A: Initial Setup and Git-Aware Defaults

Set up release provenance configuration with intelligent defaults inferred from the local Git environment.

1. **Infer GitHub repository information**:
   ```bash
   git remote get-url origin
   # Parse owner/repo from GitHub URL
   ```

2. **Configure production release refs**:
   - Look for project-scoped tag families (e.g., `refs/tags/myco/v*`)
   - Fall back to standard versioning (`refs/tags/v*`)
   - **Critical**: Always use fully qualified refs, never bare names

3. **Set up integration refs**:
   - Resolve `origin/HEAD` to find default branch
   - Fall back to `origin/main`, `origin/master`, or other common remote branches
   - **Gotcha**: Writing `main` instead of `origin/main` causes silent reconciliation failures

4. **Populate configuration**:
   ```yaml
   production_refs: [refs/tags/myco/v*]
   integration_refs: [origin/main]
   github:
     repo: owner/repo-name
   ```

5. **Validate configuration**: Ensure all refs resolve via `git for-each-ref` before proceeding.

## Procedure B: Non-Blocking Git Snapshot Capture

Implement asynchronous Git provenance capture that doesn't block session startup.

1. **Create shared Git utilities** (`packages/myco/src/release-provenance/git-cmd.ts`):
   ```typescript
   export function runGit(args: string[]): Promise<string>
   export function patchIdFromDiff(diff: string): string
   export function patchIdForCommit(sha: string): Promise<string>
   export function patchIdForRange(range: string): Promise<Map<string, string>>
   export function mergeBase(ref1: string, ref2: string): Promise<string>
   export function readOptionalRef(ref: string): Promise<string | null>
   ```

2. **Implement deferred capture** (`packages/myco/src/release-provenance/capture.ts`):
   ```typescript
   function deferGitProvenance(sessionId: string) {
     setImmediate(() => {
       captureGitProvenance(sessionId).catch(handleError);
     });
   }
   ```

3. **Deploy at critical call sites**:
   - Session register/unregister (`packages/myco/src/daemon/api/session-lifecycle.ts`)
   - Event-dispatch auto-register (`packages/myco/src/daemon/event-dispatch.ts`)
   - Prompt-batch start/stop (`packages/myco/src/daemon/stop-processing.ts`)
   - Add idempotent deduplication to prevent re-capture on retries

4. **Capture snapshot data**:
   - Current HEAD commit and patch-ID
   - Upstream range patch-IDs (`main..HEAD`)
   - Production range patch-IDs (`last-release..HEAD`)
   - Working tree dirty state

## Procedure C: Two-Tier Reconciliation Strategy

Implement reconciliation that handles both direct ancestry and squash-merge scenarios.

1. **Ancestry-based reconciliation (high confidence)**:
   ```bash
   git merge-base --is-ancestor <captured-sha> <release-ref>
   # If true → released/high confidence
   ```

2. **Patch-ID reconciliation (medium confidence)**:
   - Build `PatchIdCache` shared across reconciliation cycle (`packages/myco/src/release-provenance/reconcile.ts`)
   - For each release ref, collect patch-IDs via `git log --format=\"%H\" | xargs -n1 git show`
   - Match captured patch-IDs against release patch-IDs
   - First match wins: cache maps patch-ID → claiming ref
   - **Trade-off**: Less precise than ancestry but handles squashed commits

3. **Optimize reconciliation performance**:
   - Use shared `PatchIdCache` to avoid O(n²) scanning
   - Early exit on first match in outer ref loop
   - Batch patch-ID computation with `patchIdForRange()`

4. **Handle edge cases**:
   - Dirty working tree: `dirty_worktree/low` classification
   - No configured refs: skip with "No release provenance refs configured"
   - Missing refs: expand globs at runtime via `git for-each-ref`

## Procedure D: Knowledge Graph Propagation

Materialize derived release state and propagate to dependent systems.

1. **Implement batch-preferred lineage** (`packages/myco/src/release-provenance/record-lineage.ts`):
   ```typescript
   // Prefer batch lineage over session lineage for precision
   function getBatchLineage(sporeId: string): BatchLineage | null
   function getSessionLineage(sporeId: string): SessionLineage | null
   ```

2. **Materialize derived records**:
   - Create `knowledge_release_state` rows for spores, sessions, plans
   - Link via `record-lineage.ts` mapping
   - Skip Canopy entries (local-only, no lineage)

3. **Update vector metadata without re-embedding**:
   ```typescript
   // JSON-patch approach preserves embeddings
   VectorStore.patchDomainMetadata(id, {
     release_state: 'released',
     release_confidence: 'high'
   });
   ```

4. **Fire change notifications**:
   - Trigger `onReleaseStateChanged` callback per classification change
   - Queue power-job for vector store propagation
   - Apply only to embeddable namespaces (spores, sessions, plans, skill_records)

## Procedure E: Three-Layer Testing and Validation

Validate the complete system with comprehensive test coverage.

1. **Layer 1 - In-Process E2E Test**:
   - Cover 9 phases: capture → dedupe → reconciliation → derived records → vector metadata → search annotation → MCP surfaces → harness projections → privacy contract
   - Use fake `VectorStore` to avoid SQLite connection corruption
   - Target: 37+ assertions across all integration points

2. **Layer 2 - Build Gate**:
   ```bash
   make build
   # Must pass: 4,400+ tests, full TypeScript compilation
   ```

3. **Layer 3 - Live Daemon Smoke Test**:
   - Run against compiled binary with fake Git state
   - Validate manual reconciliation: scan all rows, verify `failed=0`
   - **Monitor**: Daemon health endpoint may briefly stop responding after manual reconcile

4. **Dogfood validation**:
   - Apply to the project itself
   - Verify configuration inference works on real repo
   - Check that manual reconcile produces `unreconciled_count=0`

## Procedure F: Privacy Controls and Selective Sync

Implement privacy-aware sync that keeps Git refs local while sharing classifications.

1. **Configure LOCAL_ONLY_SYNC_COLUMNS** (`packages/myco/src/db/queries/team-outbox.ts`):
   ```sql
   -- Stays local
   basis_ref TEXT, -- e.g., 'prod-v1'  
   basis_sha TEXT, -- commit SHA
   
   -- Syncs to team
   basis_kind TEXT, -- 'git_ancestry', 'dirty_worktree', 'configuration'
   basis_reason TEXT, -- human-readable explanation
   ```

2. **Implement composite primary key**:
   - Schema: `(id, machine_id)` for machine scoping
   - Enables per-machine Git ref privacy while sharing derived classifications

3. **Handle orphan-row self-healing**:
   ```typescript
   function classificationUnchanged(existing: Row, new: Row): boolean {
     // Treat synced_at IS NULL as "changed" to force orphan rows through sync
     if (existing.synced_at === null) return false;
     return existing.release_state === new.release_state;
   }
   ```

4. **Prevent Git ref exposure in worker APIs**:
   - `packages/myco-team/worker/src/search-helpers.ts` surfaces only `basis_kind` and `basis_reason`
   - Never include `basis_ref` or `basis_sha` in MCP annotations

## Procedure G: GitHub Token and Machine-Scoped Configuration

Implement GitHub token configuration and machine-scoped auth for release provenance.

1. **Machine-scoped token design**:
   - GitHub tokens must be stored at the **machine** scope, not grove or project scope
   - Rationale: Avoid asking users for new tokens for every grove; one token per machine covers all projects
   - Location: `packages/myco/src/daemon/api/provider-secrets.ts`
   - Config location: `~/.myco/providers.toml` (machine-level)

2. **Token lifecycle**:
   ```typescript
   // Load from machine-level config
   const ghToken = getProviderSecret('github', 'machine');
   // Never attempt to load per-grove or per-project tokens
   ```

3. **UI organization**:
   - Present settings organized by **feature flow**, not implementation details
   - Groupings: **Release Model** (preset + refs), **GitHub Evidence** (token + scope), **Reconciliation Behavior** (interval + dirty-state handling), **Monorepo** (mapping rules)
   - Each section has its own save button; design UX holistically, not field-by-field
   - Token input lives in "GitHub Evidence" section with credential masking

4. **Settings API routes**:
   - Verify all config routes in `packages/myco/src/daemon/main.ts` use `req.requestContext?.projectVaultDir` for project-scoped settings
   - Do not use `bootstrapVaultDir` in handler closures (see Gotcha: Config Routes Cross-Project Bleed)

## Cross-Cutting Gotchas

**Refs must be fully qualified**: Writing `main` instead of `origin/main` causes silent reconciliation failures. Always test `origin/HEAD` resolution path and write fully qualified refs.

**Git operations must be non-blocking**: Any Git subprocess call in the session hot path must use `setImmediate()` deferral. Session startup cannot wait for Git operations.

**Cache performance matters**: Naive reconciliation is O(n²). Use shared `PatchIdCache` per reconcile cycle, not per row.

**Squash-merge breaks ancestry**: Traditional Git ancestry (`git merge-base --is-ancestor`) fails in squash-heavy workflows. Patch-ID matching provides medium-confidence classification for squashed commits.

**Sync vs. privacy boundary**: Release classifications sync to team; Git refs and SHAs stay local. The `LOCAL_ONLY_SYNC_COLUMNS` pattern enforces this boundary.

**Vector metadata refresh without re-embedding**: Use JSON-patch updates to preserve expensive embeddings when only metadata changes.

**Self-healing orphan rows**: Rows with `synced_at IS NULL` must be treated as dirty to force them through the sync pipeline until they reach a steady state.

**Config Routes Cross-Project Bleed**: Six config routes in `packages/myco/src/daemon/main.ts` (lines 910, 917–919, 992–994, 1003–1004) must use `req.requestContext?.projectVaultDir` instead of `bootstrapVaultDir`. Hard-wiring `bootstrapVaultDir` causes settings to leak across projects within the same machine. Regression test: `tests/daemon/api/config.test.ts`.
