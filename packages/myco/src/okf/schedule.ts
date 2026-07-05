import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import { readCanopyMap } from '@myco/canopy/map/store.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { appendProjectCondition } from '@myco/db/queries/project-scope.js';
import type { OkfPrivateManifest } from '@myco/vault/project-vault.js';
import { OkfError } from './errors.js';
import { resolveOutputRoot } from './output-root.js';
import type { OkfBundleInclude, OkfSporeStatusFilter } from './types.js';

/**
 * Deterministic probe-fingerprint inputs — the SAME shape `bundle.ts`'s
 * `computeProbeFingerprint` hashes from a live `gather()` result. Extracted
 * here so the `okf-maintain-due` scheduler precondition can recompute an
 * identical hash from cheap SQL aggregates instead of a full gather().
 *
 * Keep this hashed shape IDENTICAL to what bundle.ts fed into the original
 * inline implementation — changing key names or the payload shape silently
 * invalidates every persisted `probe_fingerprint`, which would make every
 * project look "due" once (harmless) but is still worth avoiding.
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
 * Pure hash function shared by `bundle.ts` (computed from a live `gather()`
 * result at publish time) and the `okf-maintain-due` precondition probe
 * (computed from cheap SQL aggregates, never a full gather()). Both callers
 * must produce the same hash for the same underlying state, or the
 * precondition will give a false "not due" answer.
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

/**
 * The sporeStatus the config-driven scheduled maintain will use — mirrors
 * `OkfBundle`'s private `configuredSporeStatus()` exactly (single 'active'
 * ⇒ 'active', anything broader ⇒ 'all'). Duplicated here (not exported from
 * bundle.ts) because the probe must never construct an `OkfBundle` instance
 * — it runs on every scheduler tick once the interval has elapsed. Exported
 * so the executor's `finalizeOkfMaintain` (which DOES construct an
 * `OkfBundle` for the real publish) shares the same derivation instead of a
 * third copy of the ternary.
 */
export function configuredSporeStatus(config: MycoConfig): OkfSporeStatusFilter {
  const statuses = config.okf.maintain.include_status;
  return statuses.length === 1 && statuses[0] === 'active' ? 'active' : 'all';
}

function configuredInclude(config: MycoConfig): OkfBundleInclude {
  const configured = new Set(config.okf.maintain.include);
  return {
    spores: configured.has('spores'),
    canopy: configured.has('canopy'),
    concepts: configured.has('concepts'),
    guides: configured.has('guides'),
  };
}

/** `{count, maxUpdate}` for spores in scope, cheap two-column SQL aggregate. */
function probeSporeAggregate(scope: ProjectScope, status: OkfSporeStatusFilter): { count: number; maxUpdate: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, scope);
  if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = getDatabase().prepare(
    `SELECT COUNT(*) as count, COALESCE(MAX(COALESCE(updated_at, created_at)), 0) as max_update
       FROM spores
       ${where}`,
  ).get(...params) as { count: number; max_update: number };
  return { count: row.count, maxUpdate: row.max_update };
}

/**
 * `{count, maxUpdate}` for canopy entries in scope, cheap two-column SQL
 * aggregate. Mirrors `gather()`'s predicate exactly: when
 * `includeUndescribed` is false, only rows with a non-null
 * `llm_description` count (parity with `describedCanopyEntriesPredicate`).
 */
function probeCanopyAggregate(projectId: string, includeUndescribed: boolean): { count: number; maxUpdate: number } {
  const where = includeUndescribed
    ? 'project_id = ?'
    : 'project_id = ? AND llm_description IS NOT NULL';
  const row = getDatabase().prepare(
    `SELECT COUNT(*) as count,
            COALESCE(MAX(COALESCE(llm_updated_at, mechanical_updated_at, 0)), 0) as max_update
       FROM canopy_entries
      WHERE ${where}`,
  ).get(projectId) as { count: number; max_update: number };
  return { count: row.count, maxUpdate: row.max_update };
}

/** Count of `.md` files directly readable under `<outputRoot>/concepts/` (recursive), skipping reserved index/log files. */
function probeConceptCount(outputRoot: string): number {
  const conceptsRoot = path.join(outputRoot, 'concepts');
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'log.md') {
        count += 1;
      }
    }
  };
  walk(conceptsRoot);
  return count;
}

/**
 * Fail-closed scheduler precondition for the `okf-maintain` task. Returns
 * `true` (due) only when ALL of:
 *   (a) the `okf` capability is enabled;
 *   (b) the configured published path resolves to `published_default`
 *       (never fires for an external/local-only output root);
 *   (c) either no manifest exists yet (never published ⇒ due), or the
 *       recomputed probe fingerprint differs from the persisted one.
 *
 * A false "due" is harmless — the gather phase re-checks the real
 * `inputsHash` and short-circuits with zero LLM cost. A false "not due"
 * would silently starve the task, which is why every value the fingerprint
 * captures (source counts, max updated_ats, include-config, sporeStatus)
 * must come from the SAME shape `bundle.ts` persists at publish.
 *
 * Deliberately does NOT implement a "blocked pending acknowledgement" skip
 * rule — `OkfBundle.maintain()` throws `okf_publish_not_acknowledged`
 * BEFORE writing the manifest, so there is no cheap persisted signal to
 * probe for that state. `maxRunsPerDay: 4` on the task schedule plus the
 * executor's clean "publish blocked" finalization outcome bound the cost
 * of repeatedly re-attempting a blocked publish instead.
 *
 * Kept to a fixed, cheap query budget: two SQL aggregates (spores,
 * canopy_entries), one `readCanopyMap` row read, and a recursive readdir
 * count under `concepts/` — never a full `gather()` and never content
 * hashing of concept file bodies.
 */
export function okfMaintainDue(
  scope: ProjectScope,
  config: MycoConfig | null,
  projectRoot: string,
  projectId: string,
  machineId: string,
  manifest: OkfPrivateManifest | null,
): boolean {
  if (!config) return false;
  if (!capabilityEnabled(config, 'okf')) return false;

  let outputRoot: string;
  try {
    const resolved = resolveOutputRoot({
      projectRoot,
      mode: 'published',
      publishedPath: config.okf.maintain.output_path,
    });
    if (resolved.klass !== 'published_default') return false;
    outputRoot = resolved.absPath;
  } catch (err) {
    if (err instanceof OkfError) return false;
    throw err;
  }

  if (!manifest || !manifest.probe_fingerprint) return true;

  const sporeStatus = configuredSporeStatus(config);
  const include = configuredInclude(config);
  // Mirror gather()'s canopy gate exactly: capability-off degrades to the
  // same empty-canopy shape gather() falls back to (with a warning there).
  const canopyActive = include.canopy && capabilityEnabled(config, 'canopy');
  const includeUndescribed = config.okf.maintain.include_undescribed_canopy;
  const sporeAgg = include.spores ? probeSporeAggregate(scope, sporeStatus) : { count: 0, maxUpdate: 0 };
  const canopyAgg = canopyActive ? probeCanopyAggregate(projectId, includeUndescribed) : { count: 0, maxUpdate: 0 };
  const conceptCount = include.concepts ? probeConceptCount(outputRoot) : 0;
  const mapHash = canopyActive ? (readCanopyMap(projectId, machineId)?.inputs_hash ?? null) : null;

  const fingerprint = computeOkfProbeFingerprint({
    sporeCount: sporeAgg.count,
    maxSporeUpdate: sporeAgg.maxUpdate,
    canopyCount: canopyAgg.count,
    maxCanopyUpdate: canopyAgg.maxUpdate,
    conceptCount,
    mapHash,
    include,
    sporeStatus,
  });

  return fingerprint !== manifest.probe_fingerprint;
}
