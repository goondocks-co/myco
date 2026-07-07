import { sha256Hex } from '@myco/canopy/hash.js';
import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition } from '@myco/db/queries/project-scope.js';
import { readCanopyMap } from '@myco/canopy/map/store.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import { runGit } from '@myco/utils/git.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import type { OkfPrivateManifest } from '@myco/vault/project-vault.js';
import type { WikiPlan } from './synthesis/plan.js';
import type { OkfBundleInclude, OkfSporeStatusFilter } from './types.js';

/**
 * Deterministic probe-fingerprint inputs — the shape `computeOkfSynthesizeSnapshot`
 * hashes from the synthesis source reads and persists as `probe_fingerprint`
 * on publish.
 *
 * Keep this hashed shape STABLE — changing key names or the payload shape
 * silently invalidates every persisted `probe_fingerprint`, which would make
 * every project look "due" once (harmless) but is still worth avoiding.
 */
export interface OkfProbeFingerprintInputs {
  sporeCount: number;
  maxSporeUpdate: number;
  canopyCount: number;
  maxCanopyUpdate: number;
  conceptCount: number;
  mapHash: string | null;
  include: OkfBundleInclude;
  sporeStatus: OkfSporeStatusFilter;
}

/**
 * Pure hash function used by `computeOkfSynthesizeSnapshot` to compute
 * `probe_fingerprint` from the synthesis source reads at publish time.
 */
export function computeOkfProbeFingerprint(inputs: OkfProbeFingerprintInputs): string {
  return sha256Hex(
    JSON.stringify({
      spore_count: inputs.sporeCount,
      canopy_count: inputs.canopyCount,
      concept_count: inputs.conceptCount,
      max_spore_update: inputs.maxSporeUpdate,
      max_canopy_update: inputs.maxCanopyUpdate,
      map_hash: inputs.mapHash,
      include: inputs.include,
      spore_status: inputs.sporeStatus,
    }),
  );
}

// ---------------------------------------------------------------------------
// okf-synthesize-due — meaningful-change scheduler precondition
// ---------------------------------------------------------------------------

/** `{count, maxUpdate}` for active spores in scope — cheap two-column SQL aggregate, mirrors `synthesis/sources.ts`'s `gatherVault`'s fixed `status: 'active'` read. */
function probeSporeAggregate(scope: ProjectScope): { count: number; maxUpdate: number } {
  const conditions: string[] = ['status = ?'];
  const params: unknown[] = ['active'];
  appendProjectCondition(conditions, params, scope);
  const row = getDatabase().prepare(
    `SELECT COUNT(*) as count, COALESCE(MAX(COALESCE(updated_at, created_at)), 0) as max_update
       FROM spores
      WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as { count: number; max_update: number };
  return { count: row.count, maxUpdate: row.max_update };
}

/** `{count, maxUpdate}` for described canopy entries — mirrors `gatherVault`'s fixed `includeUndescribed: false` read. */
function probeCanopyAggregate(projectId: string): { count: number; maxUpdate: number } {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) as count,
            COALESCE(MAX(COALESCE(llm_updated_at, mechanical_updated_at, 0)), 0) as max_update
       FROM canopy_entries
      WHERE project_id = ? AND llm_description IS NOT NULL`,
  ).get(projectId) as { count: number; max_update: number };
  return { count: row.count, maxUpdate: row.max_update };
}

/**
 * Paths touched by `git log <sinceRef>..HEAD --name-status`, or `null` on any
 * git failure (non-git project, git unavailable, shallow clone, unreachable
 * ref) — never throws. A small, self-contained mirror of `synthesis/
 * sources.ts`'s private `gatherGitContext`/`parseNameStatus`: that module's
 * `gatherSources()` also hydrates the full repo tree and every vault row,
 * which this precondition has no use for and shouldn't pay for on every
 * scheduler tick.
 */
function changedPathsSinceRef(projectRoot: string, sinceRef: string): string[] | null {
  try {
    const raw = runGit(['log', `${sinceRef}..HEAD`, '--name-status', '--pretty=format:'], projectRoot);
    const paths = new Set<string>();
    for (const line of raw.split('\n')) {
      const match = /^[A-Z]\d*\t(.+)$/.exec(line);
      if (!match) continue;
      for (const col of match[1].split('\t')) {
        if (col) paths.add(col);
      }
    }
    return [...paths];
  } catch {
    return null;
  }
}

/** The current (spore/canopy aggregate, git HEAD) snapshot the finalize hook persists and this precondition re-derives to compare against. */
export interface OkfSynthesizeSnapshot {
  probeFingerprint: string;
  lastRunRef: { headSha: string | null; maxVaultUpdatedAt: number };
}

/**
 * Compute the live snapshot `okf-synthesize`'s finalize hook persists at
 * publish time (`probe_fingerprint` + `last_run_ref` on the manifest) and
 * `okfSynthesizeDue` recomputes on every check to compare against it. One
 * function, two callers — so the hash inputs and the HEAD-resolution logic
 * can never drift between "what got recorded" and "what we're comparing
 * against."
 *
 * Fixed at a cheap query budget: two SQL aggregates, one `readCanopyMap` row
 * read, and one `git rev-parse` call — never a full `gatherSources()`.
 */
export function computeOkfSynthesizeSnapshot(
  scope: ProjectScope,
  config: MycoConfig,
  projectRoot: string,
  projectId: string,
  machineId: string,
): OkfSynthesizeSnapshot {
  const canopyActive = capabilityEnabled(config, 'canopy');
  const sporeAgg = probeSporeAggregate(scope);
  const canopyAgg = canopyActive ? probeCanopyAggregate(projectId) : { count: 0, maxUpdate: 0 };
  const mapHash = canopyActive ? (readCanopyMap(projectId, machineId)?.inputs_hash ?? null) : null;

  const probeFingerprint = computeOkfProbeFingerprint({
    sporeCount: sporeAgg.count,
    maxSporeUpdate: sporeAgg.maxUpdate,
    canopyCount: canopyAgg.count,
    maxCanopyUpdate: canopyAgg.maxUpdate,
    conceptCount: 0,
    mapHash,
    // Synthesis has no `include`/`sporeStatus` config knobs of its own (it
    // always reads active spores + described canopy) — held at constants
    // matching `synthesis/sources.ts`'s `gatherVault` fixed read shape, so
    // this dimension of the shared fingerprint shape never moves for the
    // synthesize path.
    include: { spores: true, canopy: canopyActive, concepts: false, guides: false },
    sporeStatus: 'active',
  });

  let headSha: string | null;
  try {
    headSha = runGit(['rev-parse', 'HEAD'], projectRoot);
  } catch {
    // Non-git project, no commits yet, or git unavailable — never throw.
    headSha = null;
  }

  return {
    probeFingerprint,
    lastRunRef: { headSha, maxVaultUpdatedAt: Math.max(sporeAgg.maxUpdate, canopyAgg.maxUpdate) },
  };
}

/**
 * Fail-closed scheduler precondition for the `okf-synthesize` task. Returns
 * `true` (due) only when the `okf` capability is enabled AND EITHER no
 * bundle has been published yet, OR a **meaningful** change happened since
 * the last publish:
 *
 *   1. **Vault knowledge changed** — the live `probeFingerprint` half of
 *      `computeOkfSynthesizeSnapshot`, compared against the fingerprint
 *      persisted on the manifest at the last publish. A missing/null
 *      persisted fingerprint fails OPEN to "due" — mirrors the retired
 *      `okfMaintainDue`'s rule: a false "due" costs one
 *      skipped-if-nothing-changed run, never data loss.
 *   2. **A tracked source path changed** — the manifest's persisted
 *      `last_run_ref.headSha` (Task 2.4; recorded by the finalize hook) is
 *      the durable git baseline this task records; when present, `git log
 *      <headSha>..HEAD --name-status` is checked against the union of every
 *      planned page's `sourceRefs`. A missing baseline, an unreachable ref,
 *      or a non-git project all degrade to "no repo signal" — this arm then
 *      contributes nothing, so "due" rests entirely on the vault signal
 *      above, never "any commit changed something."
 *
 * Never throws.
 */
export function okfSynthesizeDue(
  scope: ProjectScope,
  config: MycoConfig | null,
  projectRoot: string,
  projectId: string,
  machineId: string,
  manifest: OkfPrivateManifest | null,
  plan: WikiPlan | null,
): boolean {
  if (!config) return false;
  if (!capabilityEnabled(config, 'okf')) return false;
  if (!manifest || manifest.last_result !== 'published') return true;

  const snapshot = computeOkfSynthesizeSnapshot(scope, config, projectRoot, projectId, machineId);
  if (!manifest.probe_fingerprint || snapshot.probeFingerprint !== manifest.probe_fingerprint) return true;

  const lastHeadSha = manifest.last_run_ref?.headSha ?? null;
  if (lastHeadSha && plan && plan.pages.length > 0) {
    const changed = changedPathsSinceRef(projectRoot, lastHeadSha);
    if (changed) {
      const tracked = new Set<string>();
      for (const page of plan.pages) {
        for (const ref of page.sourceRefs) tracked.add(ref);
      }
      if (changed.some((p) => tracked.has(p))) return true;
    }
  }

  return false;
}
