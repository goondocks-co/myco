import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import { listSpores, type SporeRow } from '@myco/db/queries/spores.js';
import { listResolutionEvents } from '@myco/db/queries/resolution-events.js';
import { getReleaseStatesForRecords } from '@myco/db/queries/release-provenance.js';
import { listFullCanopyEntries } from '@myco/db/queries/canopy.js';
import { readCanopyMap, type CanopyMapRow } from '@myco/canopy/map/store.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import {
  OKF_PROJECTION_VERSION,
  OKF_RESERVED_FILES,
  type OkfBundleInclude,
  type OkfMaintainWarning,
  type OkfSporeStatusFilter,
} from './types.js';

const RESERVED_BASENAMES = new Set<string>(OKF_RESERVED_FILES);

/**
 * Record gathering for a maintain run: fetch the vault rows that project into
 * concepts, read existing agent-maintained concept files, and compute a
 * deterministic `inputs_hash` for short-circuiting.
 *
 * All DB reads go through existing query helpers with explicit scope/projectId
 * and a high limit (the helpers default to LIMIT 100 — a whole-project export
 * would silently truncate otherwise). Never derives identity from cwd.
 */

/** Bumps when the gather shape / hashing changes, invalidating short-circuits. */
const OKF_GATHER_VERSION = '1';
/** High ceiling for project-scoped reads; far above any real vault. */
const GATHER_LIMIT = 1_000_000;

export interface OkfGatherContext {
  projectRoot: string;
  scope: ProjectScope;
  projectId: string;
  machineId: string;
  config: MycoConfig;
  /** Resolved absolute output root (bundle.ts resolves once and passes it). */
  outputRoot: string;
}

export interface OkfGatherParams {
  include: OkfBundleInclude;
  sporeStatus: OkfSporeStatusFilter;
  includeUndescribedCanopy: boolean;
}

export interface OkfResolutionEdge {
  spore_id: string;
  new_spore_id: string | null;
  action: string;
}

export interface OkfConceptFile {
  bundleRelPath: string;
  raw: string;
  mtimeIso: string;
}

export interface OkfGatherResult {
  spores: SporeRow[];
  resolutionEdges: OkfResolutionEdge[];
  releaseStates: Map<string, string>;
  canopyEntries: CanopyEntry[];
  canopyMap: CanopyMapRow | null;
  conceptFiles: OkfConceptFile[];
  /** Ids of the fetched spores — the projector's included-set for link handling. */
  includedSporeIds: Set<string>;
  inputsHash: string;
  warnings: OkfMaintainWarning[];
}

/** Recursively read `<outputRoot>/concepts/**​/*.md` into concept-file records. */
function readExistingConceptFiles(outputRoot: string): OkfConceptFile[] {
  const conceptsRoot = path.join(outputRoot, 'concepts');
  const out: OkfConceptFile[] = [];
  const walk = (relDir: string): void => {
    const absDir = path.join(conceptsRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      // Skip GENERATED index.md/log.md files: they live inside concepts/ after
      // a publish but must never be re-adopted as agent concepts (adoptConcepts
      // hard-rejects reserved names, which would break every later maintain).
      // Parity with reconstructConceptSet/listConcepts in bundle.ts.
      if (!entry.isFile() || !entry.name.endsWith('.md') || RESERVED_BASENAMES.has(entry.name)) continue;
      const abs = path.join(conceptsRoot, rel);
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        const mtimeIso = fs.statSync(abs).mtime.toISOString();
        out.push({ bundleRelPath: `concepts/${rel}`, raw, mtimeIso });
      } catch {
        /* skip unreadable */
      }
    }
  };
  walk('');
  return out;
}

function sortByFirst<T extends unknown[]>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
}

export function gather(ctx: OkfGatherContext, params: OkfGatherParams): OkfGatherResult {
  const warnings: OkfMaintainWarning[] = [];

  // --- Spores ---
  const spores = params.include.spores
    ? listSpores({
        scope: ctx.scope,
        status: params.sporeStatus === 'all' ? undefined : params.sporeStatus,
        limit: GATHER_LIMIT,
      })
    : [];
  const includedSporeIds = new Set(spores.map((s) => s.id));

  // --- Resolution edges + release states (only meaningful with spores) ---
  const resolutionEdges: OkfResolutionEdge[] = params.include.spores
    ? listResolutionEvents({ scope: ctx.scope, limit: GATHER_LIMIT }).map((e) => ({
        spore_id: e.spore_id,
        new_spore_id: e.new_spore_id,
        action: e.action,
      }))
    : [];

  const releaseStates = new Map<string, string>();
  if (params.include.spores && spores.length > 0) {
    const stateRows = getReleaseStatesForRecords('spores', [...includedSporeIds], ctx.scope);
    for (const [id, row] of stateRows) releaseStates.set(id, row.state);
  }

  // --- Canopy (gated on the Canopy capability; never enqueues describe/map work) ---
  let canopyEntries: CanopyEntry[] = [];
  let canopyMap: CanopyMapRow | null = null;
  if (params.include.canopy) {
    if (capabilityEnabled(ctx.config, 'canopy')) {
      canopyEntries = listFullCanopyEntries(getDatabase(), ctx.projectId, {
        includeUndescribed: params.includeUndescribedCanopy,
        limit: GATHER_LIMIT,
      });
      canopyMap = readCanopyMap(ctx.projectId, ctx.machineId);
    } else {
      warnings.push({
        code: 'canopy_capability_disabled',
        message: 'Canopy is disabled for this project; canopy concepts were skipped.',
      });
    }
  }

  // --- Existing agent-maintained concept files ---
  const conceptFiles = params.include.concepts ? readExistingConceptFiles(ctx.outputRoot) : [];

  // --- Deterministic inputs hash (NO current-run timestamps) ---
  const hashPayload = {
    gather_version: OKF_GATHER_VERSION,
    projection_version: OKF_PROJECTION_VERSION,
    include: params.include,
    spore_status: params.sporeStatus,
    include_undescribed_canopy: params.includeUndescribedCanopy,
    spores: sortByFirst(
      spores.map((s) => [s.id, s.content_hash ?? sha256Hex(s.content), s.status, s.updated_at ?? s.created_at] as const),
    ),
    release_states: sortByFirst([...releaseStates.entries()].map(([id, state]) => [id, state] as const)),
    resolution_edges: sortByFirst(
      resolutionEdges.map((e) => [`${e.spore_id}:${e.new_spore_id ?? ''}:${e.action}`] as const),
    ),
    canopy: sortByFirst(canopyEntries.map((e) => [e.path, e.content_hash, e.llm_updated_at ?? 0] as const)),
    canopy_map: canopyMap ? [canopyMap.inputs_hash, canopyMap.generated_at] : null,
    concepts: sortByFirst(conceptFiles.map((f) => [f.bundleRelPath, sha256Hex(f.raw)] as const)),
  };
  const inputsHash = sha256Hex(JSON.stringify(hashPayload));

  return {
    spores,
    resolutionEdges,
    releaseStates,
    canopyEntries,
    canopyMap,
    conceptFiles,
    includedSporeIds,
    inputsHash,
    warnings,
  };
}
