import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import type { ProjectVault, OkfPrivateManifest } from '@myco/vault/project-vault.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import type { OkfOwnership } from './ownership.js';
import { getDatabase } from '@myco/db/client.js';
import { listSpores, type SporeRow } from '@myco/db/queries/spores.js';
import { listResolutionEvents } from '@myco/db/queries/resolution-events.js';
import { getReleaseStatesForRecords } from '@myco/db/queries/release-provenance.js';
import { listFullCanopyEntries } from '@myco/db/queries/canopy.js';
import { readCanopyMap, type CanopyMapRow } from '@myco/canopy/map/store.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { OkfError } from './errors.js';
import { resolveOutputRoot, type OutputClass } from './output-root.js';
import { computeOkfProbeFingerprint } from './schedule.js';
import { mycoProjectRef, runRef } from './privacy.js';
import { assertSafeConceptId, conceptPathForId, detectCollisions, OkfPathError } from './paths.js';
import { parseConceptDoc, serializeConceptDoc } from './frontmatter.js';
import { renderConcept, renderOkfDocument, renderRootIndex, renderRootLog, type OkfLogEntry } from './serialize.js';
import { generateDirectoryIndexes, generateIndexes } from './indexes.js';
import { validateBundleTree, validateConceptSource } from './validate.js';
import { scanStagedBundle } from './publish-eligibility.js';
import {
  OKF_MARKER_FILENAME,
  OKF_PROJECTION_VERSION,
  OKF_RESERVED_FILES,
  OKF_VERSION,
  type OkfBundleInclude,
  type OkfBundleMode,
  type OkfBundleWriteInput,
  type OkfBundleWriteResult,
  type OkfConcept,
  type OkfDocument,
  type OkfMaintainWarning,
  type OkfSporeStatusFilter,
  type OkfValidationReport,
} from './types.js';

export { OkfError } from './errors.js';
export type { OutputClass } from './output-root.js';
export type { OkfBundleWriteResult } from './types.js';

// ---------------------------------------------------------------------------
// Filesystem seam — structural ops the failure-injection tests override.
// ---------------------------------------------------------------------------

export interface OkfFsOps {
  rename(from: string, to: string): void;
  rm(target: string, opts: { recursive: boolean; force: boolean }): void;
  mkdir(target: string, opts: { recursive: boolean }): void;
  stat(target: string): fs.Stats;
}

const defaultFsOps: OkfFsOps = {
  rename: (from, to) => fs.renameSync(from, to),
  rm: (target, opts) => fs.rmSync(target, opts),
  mkdir: (target, opts) => {
    fs.mkdirSync(target, opts);
  },
  stat: (target) => fs.statSync(target),
};

// ---------------------------------------------------------------------------
// Public interfaces (frozen — consumed by Plan 5 surfaces).
// ---------------------------------------------------------------------------

export interface OkfBundleDeps {
  projectRoot: string;
  vault: ProjectVault;
  scope: ProjectScope;
  projectId: string;
  machineId: string;
  config: MycoConfig;
  now?: () => Date;
  /** Injectable structural fs ops; defaults to node:fs. */
  fsOps?: OkfFsOps;
  /** Lock acquisition tuning; defaults to 30s timeout / 100ms retry. */
  lockOptions?: { timeoutMs?: number; retryMs?: number };
  /**
   * Render seam: turns gathered vault rows into the bundle's OKF documents.
   * The real agent-synthesis pipeline is Phase 2; until then the production
   * default throws `not_implemented` and tests inject a fixture.
   */
  renderDocuments?: (gathered: OkfGatherResult) => OkfDocument[] | Promise<OkfDocument[]>;
}

export interface OkfBundleStatus {
  outputRoot: string;
  bundleExists: boolean;
  bundleGeneration: number | null;
  inputsHash: string | null;
  generatedAt: string | null;
  lastResult: OkfPrivateManifest['last_result'];
  /** Content-document counts grouped by OKF frontmatter `type` (replaces per-include-kind `counts`). */
  byType: Record<string, number> | null;
  conceptCount: number | null;
  stale: boolean;
  publishAcknowledged: boolean;
}

/**
 * Open staged-generation session — the single write transaction for an OKF
 * document bundle. `beginStagedGeneration` acquires the lock ONCE and opens a
 * staging dir seeded with every currently-published content page (so a run
 * that only touches a subset of pages carries the rest forward); `stageDocument`
 * writes one document into it, overwriting its seeded copy if any; `finalize`
 * generates indexes over the full carried-forward + freshly-staged set,
 * validates `strict`, atomically swaps the staged tree into place, writes the
 * manifest, and releases the lock; `abort` rolls back the staging dir and
 * releases the lock without touching the published bundle.
 */
export interface StagedGeneration {
  stageDocument(doc: OkfDocument): void;
  finalize(opts?: {
    inputsHash?: string;
    probeFingerprint?: string | null;
    /** Task 2.4's `okf-synthesize-due` baseline — recorded on the manifest verbatim (omitted ⇒ reset to null, mirrors `probeFingerprint`). */
    lastRunRef?: { headSha: string | null; maxVaultUpdatedAt: number } | null;
    logSummary?: string;
  }): Promise<OkfBundleWriteResult>;
  abort(): void;
}

export interface BeginStagedGenerationInput {
  mode: OkfBundleMode;
  outputRoot?: string;
  allowExternalOutput?: boolean;
  overwrite?: boolean;
  acknowledgePublish?: boolean;
  dryRun?: boolean;
  generatedByRunId?: string | null;
  /** Warnings gathered before the session opened (forwarded into the result + marker). */
  gatherWarnings?: OkfMaintainWarning[];
}

/** Internal richer session — `runManagedMaintain` needs the reconciled manifest + gather-warning sink. */
interface StagedSession extends StagedGeneration {
  readonly outputRoot: string;
  readonly generatedAt: string;
  /** The reconciled manifest (post crash-recovery), for the unchanged short-circuit. */
  readonly manifest: OkfPrivateManifest | null;
  bundleExists(): boolean;
  addWarnings(extra: OkfMaintainWarning[]): void;
}

export interface OkfConceptProvenance {
  actor: 'symbiont' | 'harness' | 'cli';
  sessionRef?: string;
  runRef?: string;
}

export interface SaveOkfConceptInput {
  id: string;
  markdown: string;
  expectedGeneration?: number;
  provenance: OkfConceptProvenance;
}

export interface SaveOkfConceptResult {
  id: string;
  bundleGeneration: number;
  validation: OkfValidationReport;
}

export interface SupersedeOkfConceptInput {
  oldId: string;
  newId: string;
  reason: string;
  expectedGeneration?: number;
  provenance: OkfConceptProvenance;
}

export interface SupersedeOkfConceptResult {
  oldId: string;
  newId: string;
  bundleGeneration: number;
}

export interface OkfConceptSummary {
  id: string;
  type: string;
  title?: string;
  status?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 100;
const RENAME_RETRY_ATTEMPTS = 3;
const RENAME_RETRY_MS = 100;
const RENDER_YIELD_EVERY = 64;

const RESERVED_BASENAMES = new Set<string>(OKF_RESERVED_FILES);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldPoint(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Legacy projection gather — inlined from the deleted `gather.ts`. Feeds the
// pre-synthesis `runManagedMaintain`/`externalExport`/`status` paths (the
// inputs_hash short-circuit, warnings, probe fingerprint). The new
// agent-synthesis pipeline reads source material through
// `synthesis/sources.ts`'s `gatherSources` instead, which reduces vault rows
// to citable summaries rather than full projection rows; this half stays
// local to OkfBundle until Task 2.3 rewires `okf-synthesize` to drive
// `beginStagedGeneration` directly, at which point this gather→render path
// retires.
// ---------------------------------------------------------------------------

/** Bumps when the gather shape / hashing changes, invalidating short-circuits. */
const OKF_GATHER_VERSION = '1';
/** High ceiling for project-scoped reads; far above any real vault. */
const GATHER_LIMIT = 1_000_000;

interface OkfGatherContext {
  projectRoot: string;
  scope: ProjectScope;
  projectId: string;
  machineId: string;
  config: MycoConfig;
  /** Resolved absolute output root (bundle.ts resolves once and passes it). */
  outputRoot: string;
}

interface OkfGatherParams {
  include: OkfBundleInclude;
  sporeStatus: OkfSporeStatusFilter;
  includeUndescribedCanopy: boolean;
}

interface OkfResolutionEdge {
  spore_id: string;
  new_spore_id: string | null;
  action: string;
}

interface OkfConceptFile {
  bundleRelPath: string;
  raw: string;
  mtimeIso: string;
}

/** Result shape of the legacy projection gather — test fixtures inject a `renderDocuments` keyed to this. */
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
      // Parity with reconstructConceptSet/listConcepts below.
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

function gather(ctx: OkfGatherContext, params: OkfGatherParams): OkfGatherResult {
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

/** The single writer of OKF bundle files. */
export class OkfBundle {
  private readonly deps: OkfBundleDeps;
  private readonly fsOps: OkfFsOps;
  private readonly now: () => Date;

  constructor(deps: OkfBundleDeps) {
    this.deps = deps;
    this.fsOps = deps.fsOps ?? defaultFsOps;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------
  // Output-root resolution + locking
  // -------------------------------------------------------------------

  private resolve(input: Pick<OkfBundleWriteInput, 'mode' | 'outputRoot' | 'allowExternalOutput'>) {
    return resolveOutputRoot({
      projectRoot: this.deps.projectRoot,
      mode: input.mode,
      requested: input.outputRoot,
      publishedPath: this.deps.config.okf.maintain.output_path,
      localBundleDir: this.deps.vault.okfLocalBundleDir(),
      allowExternalOutput: input.allowExternalOutput,
    });
  }

  private async acquireLock(): Promise<LockHandle> {
    const lockPath = this.deps.vault.okfLockPath();
    this.deps.vault.okfStateDir(); // materialize state dir + gitignore first
    const timeoutMs = this.deps.lockOptions?.timeoutMs ?? LOCK_TIMEOUT_MS;
    const retryMs = this.deps.lockOptions?.retryMs ?? LOCK_RETRY_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = LifecycleLock.acquire(lockPath);
      if (result.acquired) return result.lock;
      if (Date.now() >= deadline) {
        throw new OkfError(
          'okf_maintain_failed',
          `OKF lock held by pid ${result.holderPid ?? 'unknown'}; timed out after ${timeoutMs}ms`,
        );
      }
      await sleep(retryMs);
    }
  }

  private releaseLock(lock: LockHandle): void {
    lock.release();
    // acquire() registers `lock.release` as an 'exit' listener and never
    // removes it — drop it so scheduled runs don't leak one per maintain.
    process.removeListener('exit', lock.release as unknown as NodeJS.ExitListener);
  }

  // -------------------------------------------------------------------
  // maintain()
  // -------------------------------------------------------------------

  async maintain(input: OkfBundleWriteInput): Promise<OkfBundleWriteResult> {
    const resolved = this.resolve(input);

    // Gate is enforced INSIDE the capability (fail-closed), not at callers.
    // Applies to every managed write — published_default AND private_local;
    // only dry-run/one-shot preview and external export bypass it.
    if (resolved.klass !== 'external_export' && !input.dryRun && !input.oneShot) {
      if (!capabilityEnabled(this.deps.config, 'okf')) {
        throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
      }
    }

    if (resolved.klass === 'external_export') {
      return this.externalExport(input, resolved.absPath);
    }

    // The managed path takes the lock ONCE — inside the staged session opened
    // by runManagedMaintain — not here. Acquiring it here too would deadlock.
    return this.runManagedMaintain(input, resolved.absPath);
  }

  /**
   * Managed maintain: open a staged session (acquires the lock + runs crash
   * recovery under it), gather inputs, short-circuit an unchanged run, then
   * render the OKF documents and publish them through the one staged
   * transaction. Full rebuild, not incremental — `renderDocuments` derives
   * the complete desired page set from current vault state every run, so
   * this deliberately does NOT carry the previously-published tree forward:
   * a page whose source no longer exists in the vault must not survive.
   */
  private async runManagedMaintain(
    input: OkfBundleWriteInput,
    outputRoot: string,
  ): Promise<OkfBundleWriteResult> {
    const session = await this.openStagedSession(
      {
        mode: input.mode,
        outputRoot: input.outputRoot,
        allowExternalOutput: input.allowExternalOutput,
        overwrite: input.overwrite,
        acknowledgePublish: input.acknowledgePublish,
        dryRun: input.dryRun,
        generatedByRunId: input.generatedByRunId,
      },
      false,
    );
    try {
      const gathered = gather(
        {
          projectRoot: this.deps.projectRoot,
          scope: this.deps.scope,
          projectId: this.deps.projectId,
          machineId: this.deps.machineId,
          config: this.deps.config,
          outputRoot,
        },
        {
          include: this.effectiveInclude(input.include),
          sporeStatus: input.sporeStatus,
          includeUndescribedCanopy: input.includeUndescribedCanopy ?? false,
        },
      );
      session.addWarnings(gathered.warnings);

      // Unchanged short-circuit — BEFORE the session sweeps or stages anything,
      // so a no-op run leaves stale backups in place for the next real run to
      // sweep. Forwards only gather warnings, matching the pre-seam contract.
      if (!input.dryRun && session.bundleExists() && session.manifest?.inputs_hash === gathered.inputsHash) {
        session.abort();
        return this.unchangedResult(outputRoot, session.manifest, gathered);
      }

      const docs = await this.renderDocuments(gathered);
      for (const doc of docs) session.stageDocument(doc);
      return await session.finalize({
        inputsHash: gathered.inputsHash,
        probeFingerprint: this.computeProbeFingerprint(gathered, input),
        logSummary: `Regenerated ${docs.length} page${docs.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      // Release the lock + drop staging on any pre-finalize failure. Idempotent:
      // finalize() already releases in its own finally on a mid-publish throw.
      session.abort();
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // Open staged generation — the single document-bundle write transaction
  // -------------------------------------------------------------------

  /**
   * Public entry: open a staged session for a caller (Phase 2 synthesis) to
   * drive. Carries forward every currently-published content page into the
   * new staging dir (lazily, on the first write) — the synthesis plan caps a
   * run at ~30 pages and drains across runs, so a page this run doesn't touch
   * must survive finalize's atomic-replace, not disappear with it.
   */
  async beginStagedGeneration(input: BeginStagedGenerationInput): Promise<StagedGeneration> {
    return this.openStagedSession(input, true);
  }

  /**
   * Public entry: ensure `ownership.json` reflects the currently-published
   * marker's generation, backfilling it from the on-disk tree when it's
   * missing or stale. Reuses {@link reconcileOwnershipForRoot} — the SAME
   * signal (`!existing || existing.bundleGeneration !== markerGen`) covers
   * both crash recovery (the ownership write for a completed publish never
   * landed) AND cold-start (a bundle published before ownership tracking
   * existed at all, so no `ownership.json` was ever written). A cold-start
   * backfill necessarily ADOPTS whatever is currently on disk as the
   * Myco-owned baseline: there is no prior fingerprint to compare against, so
   * a hand-edit made before ownership existed can't be distinguished from
   * Myco's own output.
   *
   * Callers that gate a per-page write on ownership (`okf_write_page`) MUST
   * call this first — reading `readOkfOwnership()` directly, without
   * reconciling, would see a missing/stale file as "every page is foreign"
   * on any bundle whose ownership tracking hasn't caught up yet.
   *
   * Returns the reconciled ownership (null when nothing is published at this
   * root yet). Cheap once ownership already matches the marker generation —
   * the underlying reconcile no-ops and this is just a lock round-trip.
   */
  async reconcileOwnership(): Promise<OkfOwnership | null> {
    if (!capabilityEnabled(this.deps.config, 'okf')) {
      throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
    }
    const outputRoot = this.resolve({ mode: 'published' }).absPath;
    const lock = await this.acquireLock();
    try {
      this.reconcileOwnershipForRoot(outputRoot, []);
      return this.deps.vault.readOkfOwnership();
    } finally {
      this.releaseLock(lock);
    }
  }

  /**
   * Read the current `ownership.json` WITHOUT reconciling it — a lock-free
   * peek. A `StagedGeneration` this same bundle's `beginStagedGeneration`
   * opened holds the OKF lock for its ENTIRE lifetime (open → finalize/abort,
   * not per-write) — calling {@link reconcileOwnership} while such a session
   * is open for the SAME run would try to re-acquire a lock this process
   * already holds and block until the lock timeout. A caller that knows a
   * session for this run is already open (it reconciled ownership when IT
   * opened, and nothing else can publish concurrently while it holds the
   * lock) should use this instead.
   */
  currentOwnership(): OkfOwnership | null {
    return this.deps.vault.readOkfOwnership();
  }

  private async openStagedSession(
    input: BeginStagedGenerationInput,
    carryForward: boolean,
  ): Promise<StagedSession> {
    const resolved = this.resolve({
      mode: input.mode,
      outputRoot: input.outputRoot,
      allowExternalOutput: input.allowExternalOutput,
    });
    if (resolved.klass === 'external_export') {
      throw new OkfError(
        'okf_maintain_failed',
        'staged generation does not support external export; use maintain() for an external --out',
      );
    }
    // Fail-closed capability gate — structural, mirrors maintain(); dry-run previews bypass it.
    if (!input.dryRun && !capabilityEnabled(this.deps.config, 'okf')) {
      throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
    }

    const outputRoot = resolved.absPath;
    const isPublished = resolved.klass === 'published_default';
    const generatedAt = this.now().toISOString();
    const warnings: OkfMaintainWarning[] = [...(input.gatherWarnings ?? [])];

    const lock = await this.acquireLock();
    let released = false;
    let stagingDir: string | null = null;
    let manifest: OkfPrivateManifest | null = null;
    const docs: OkfDocument[] = [];
    // Populated by seedStagingFromPublished when carryForward is set — pages
    // this run's stageDocument calls never touch, reconstructed from the
    // staging copy so finalize's index/count/collision pass sees them too.
    const carriedForwardDocs = new Map<string, OkfDocument>();

    const release = (): void => {
      if (released) return;
      released = true;
      if (stagingDir) this.safeRm(stagingDir);
      this.releaseLock(lock);
    };

    try {
      // Recovery + reconcile + write-guard — under the lock, before any write.
      manifest = this.deps.vault.readOkfManifest();
      manifest = this.reconcileManifestForRoot(manifest, outputRoot, warnings);
      // Restore a crash-orphaned bundle BEFORE recoverFromCrash reads the marker
      // and BEFORE sweepStale would delete the sole surviving backup copy.
      this.recoverOrphanedBundle(outputRoot, warnings);
      manifest = this.recoverFromCrash(manifest, outputRoot, warnings);
      this.reconcileOwnershipForRoot(outputRoot, warnings);
      this.assertOutputWritable(outputRoot, input.overwrite ?? false);
    } catch (err) {
      release();
      throw err;
    }

    // Sweep stale backups/staging + open a fresh staging dir on the first stage.
    // Deferring past the caller's short-circuit keeps sweepStale off no-op runs.
    const ensureStaging = (): string => {
      if (stagingDir) return stagingDir;
      this.sweepStale(manifest, warnings);
      stagingDir = this.freshStagingDir();
      if (carryForward) this.seedStagingFromPublished(stagingDir, outputRoot, carriedForwardDocs);
      return stagingDir;
    };

    const finalize: StagedGeneration['finalize'] = async (opts) => {
      const dir = ensureStaging();
      const inputsHash = opts?.inputsHash ?? '';
      try {
        const nextGeneration = (manifest?.bundle_generation ?? 0) + 1;
        // Carried-forward pages this run never staged still need to reach
        // generateIndexes/byTypeOf/the collision guard below — those only see
        // what `docs` collected via stageDocument, not what's physically
        // sitting in the staging dir. A path this run DID stage wins over its
        // (now stale) seeded copy.
        const stagedPaths = new Set(docs.map((d) => d.path));
        const contentDocs =
          carriedForwardDocs.size === 0
            ? docs
            : [...docs, ...[...carriedForwardDocs.values()].filter((d) => !stagedPaths.has(d.path))];
        const { pageCount, byType } = this.materializeStagedTree(dir, contentDocs, {
          generatedAt,
          inputsHash,
          mode: input.mode,
          priorLog: input.mode === 'published' ? this.readRootLog(outputRoot) : null,
          logSummary: opts?.logSummary ?? `Published ${docs.length} page${docs.length === 1 ? '' : 's'}.`,
          generatedByRunRef: runRef(input.generatedByRunId) ?? null,
          bundleGeneration: nextGeneration,
          warnings,
        });

        const findings = scanStagedBundle(dir);
        const publishEligibility = {
          ok: findings.length === 0,
          findings: findings.map((f) => ({ code: f.code, path: f.path, excerpt: f.excerpt })),
        };

        if (isPublished && !input.dryRun) {
          const acknowledged = manifest?.acknowledged_findings ?? [];
          const unacked = findings.filter((f) => !this.findingAcknowledged(f, acknowledged));
          if (unacked.length > 0 && !input.acknowledgePublish) {
            throw new OkfError('okf_publish_not_acknowledged', 'publish blocked by unacknowledged findings', {
              findings: unacked,
            });
          }
        }

        const validation = validateBundleTree(dir, 'strict', { mode: input.mode });
        if (!validation.ok) {
          throw new OkfError('okf_validation_failed', 'generated bundle failed strict validation', { validation });
        }

        const result: OkfBundleWriteResult = {
          outputRoot,
          dryRun: input.dryRun ?? false,
          generatedAt,
          conceptCount: pageCount,
          byType,
          warnings,
          validation,
          inputsHash,
          unchanged: false,
          publishEligibility,
        };
        if (input.dryRun) return result;

        this.assertSameFilesystem(dir, outputRoot);
        const cleanupPending = this.atomicReplace(dir, outputRoot, nextGeneration, manifest);

        const ackSet = this.mergeAcknowledgements(manifest, findings, isPublished, input.acknowledgePublish ?? false);
        this.deps.vault.writeOkfManifest({
          bundle_generation: nextGeneration,
          inputs_hash: inputsHash,
          output_root: outputRoot,
          last_result: cleanupPending ? 'cleanup_pending' : 'published',
          generated_at: generatedAt,
          acknowledged_findings: ackSet,
          probe_fingerprint: opts?.probeFingerprint ?? null,
          // Preserve the prior manifest's baseline when this caller doesn't
          // provide one — the legacy `runManagedMaintain` path (still reachable
          // via `.maintain()`/"Maintain Now") never passes `lastRunRef`, and a
          // successful legacy publish must not silently erase the
          // `okf-synthesize-due` baseline a prior synthesize run recorded.
          last_run_ref: opts?.lastRunRef ?? manifest?.last_run_ref ?? null,
        });
        // Ownership — manifest-adjacent write, same as writeOkfManifest above: one
        // fingerprint per currently-published page, read back from the swapped-in
        // tree so it reflects exactly what's live. A crash between the atomic
        // swap and this write is healed by reconcileOwnershipForRoot on the next
        // session open (it recomputes from disk whenever the marker generation
        // doesn't match this file's).
        this.deps.vault.writeOkfOwnership(this.computeOwnershipFromTree(outputRoot, nextGeneration, generatedAt));
        if (cleanupPending) {
          warnings.push({ code: 'cleanup_pending', message: 'bundle published but a stale backup could not be removed; it will be swept next run.' });
        }
        return result;
      } finally {
        // Success renamed staging into place (safeRm no-ops); dry-run/error clean it.
        release();
      }
    };

    return {
      outputRoot,
      generatedAt,
      manifest,
      bundleExists: () => this.markerExists(outputRoot),
      addWarnings: (extra: OkfMaintainWarning[]) => {
        warnings.push(...extra);
      },
      stageDocument: (doc: OkfDocument) => {
        const dir = ensureStaging();
        docs.push(doc);
        this.writeStagedDoc(dir, doc);
      },
      finalize,
      abort: () => release(),
    };
  }

  // -------------------------------------------------------------------
  // External (non-atomic one-shot) export
  // -------------------------------------------------------------------

  private async externalExport(input: OkfBundleWriteInput, outputRoot: string): Promise<OkfBundleWriteResult> {
    const generatedAt = this.now().toISOString();
    const warnings: OkfMaintainWarning[] = [];

    if (this.dirExists(outputRoot) && fs.readdirSync(outputRoot).length > 0 && !(input.overwrite ?? false)) {
      throw new OkfError('non_myco_output_present', 'external output directory is not empty; pass overwrite to replace it');
    }

    const gathered = gather(
      {
        projectRoot: this.deps.projectRoot,
        scope: this.deps.scope,
        projectId: this.deps.projectId,
        machineId: this.deps.machineId,
        config: this.deps.config,
        outputRoot,
      },
      {
        include: this.effectiveInclude(input.include),
        sporeStatus: input.sporeStatus,
        includeUndescribedCanopy: input.includeUndescribedCanopy ?? false,
      },
    );
    warnings.push(...gathered.warnings);

    const stagingDir = this.freshStagingDir();
    try {
      const docs = await this.renderDocuments(gathered);
      for (const doc of docs) this.writeStagedDoc(stagingDir, doc);
      const { pageCount, byType } = this.materializeStagedTree(stagingDir, docs, {
        generatedAt,
        inputsHash: gathered.inputsHash,
        mode: input.mode,
        priorLog: null,
        logSummary: `One-shot export of ${docs.length} page${docs.length === 1 ? '' : 's'}.`,
        generatedByRunRef: runRef(input.generatedByRunId) ?? null,
        bundleGeneration: 0,
        warnings,
      });

      const findings = scanStagedBundle(stagingDir);
      const validation = validateBundleTree(stagingDir, 'strict', { mode: input.mode });
      if (!validation.ok) {
        throw new OkfError('okf_validation_failed', 'generated bundle failed strict validation', { validation });
      }

      if (!(input.dryRun ?? false)) {
        // Non-atomic: write the tree directly. NEVER touches manifest/generation.
        if (this.dirExists(outputRoot)) this.fsOps.rm(outputRoot, { recursive: true, force: true });
        this.fsOps.mkdir(path.dirname(outputRoot), { recursive: true });
        this.fsOps.rename(stagingDir, outputRoot);
      }

      return {
        outputRoot,
        dryRun: input.dryRun ?? false,
        generatedAt,
        conceptCount: pageCount,
        byType,
        warnings,
        validation,
        inputsHash: gathered.inputsHash,
        unchanged: false,
        publishEligibility: {
          ok: findings.length === 0,
          findings: findings.map((f) => ({ code: f.code, path: f.path, excerpt: f.excerpt })),
        },
      };
    } finally {
      this.safeRm(stagingDir);
    }
  }

  // -------------------------------------------------------------------
  // Document rendering + staged-tree materialization
  // -------------------------------------------------------------------

  /**
   * The sporeStatus the gather() path uses. Task 4.2 retired
   * `okf.maintain.include_status` from the config schema (the Myco-shaped
   * include surface has no document-model equivalent), so this is now a fixed
   * constant rather than config-driven — it reproduces the old schema default
   * (`include_status: ['active']`) exactly.
   *
   * TWO consumers, and they differ in liveness — the retirement cleanup must
   * NOT treat this whole helper as dead:
   *   - `maintain()`/`runManagedMaintain`: DEAD in production today
   *     (`renderDocuments` throws `not_implemented` before maintain completes).
   *   - `status()`'s staleness probe (inputs_hash comparison): LIVE — runs on
   *     every `GET /api/okf/status` / `myco okf status`, does NOT go through
   *     `renderDocuments`. So this helper IS reachable in production via
   *     `status()`; whoever retires the inline-gather duplication (tracked
   *     cleanup, Task 2.1/2.3) must keep the `status()` probe path working.
   * Because the config leaf no longer exists, no config can diverge from this
   * constant, so the probe and any future maintain gather always agree.
   */
  private configuredSporeStatus(): 'active' | 'all' {
    return 'active';
  }

  /**
   * The include-set the legacy gather()/runManagedMaintain path uses when a
   * caller doesn't pass an explicit `include`. Fixed constant, not
   * config-driven — see {@link configuredSporeStatus}'s doc comment for why.
   * Reproduces the old schema default (`include: ['spores','canopy',
   * 'concepts','guides']`) exactly.
   */
  private effectiveInclude(include?: OkfBundleInclude): OkfBundleInclude {
    if (include) return include;
    return { spores: true, canopy: true, concepts: true, guides: true };
  }

  /**
   * Render seam: turns gathered vault rows into the bundle's OKF documents.
   * The agent-synthesis pipeline that fills this is Phase 2; until then the
   * production default throws `not_implemented`, and callers (tests, and later
   * the synthesis task) inject a `renderDocuments` via {@link OkfBundleDeps}.
   */
  private async renderDocuments(gathered: OkfGatherResult): Promise<OkfDocument[]> {
    if (this.deps.renderDocuments) return this.deps.renderDocuments(gathered);
    throw new OkfError('not_implemented', 'OKF document synthesis is not yet implemented (Phase 2)');
  }

  /**
   * Write one staged document. The index/content discriminator is EMPTY
   * FRONTMATTER, not the basename: `generateIndexes` emits index docs with
   * `frontmatter: {}`, and content docs always carry the four-key floor.
   *
   * - Empty frontmatter → a plain-markdown index/log with no `---` block. It
   *   must NOT route through `renderOkfDocument` (which demands the four-key
   *   floor an index lacks). Its path is traversal-checked, and its basename
   *   MUST be reserved (`index.md`/`log.md`) — an empty-frontmatter doc at any
   *   other path is a malformed content doc, rejected rather than written
   *   frontmatter-less.
   * - Non-empty frontmatter → a content doc through `renderOkfDocument`, which
   *   enforces the four-key floor AND rejects the reserved `index.md`/`log.md`
   *   basenames. Dispatching by basename instead would let a content doc named
   *   `index.md` be written frontmatter-less and then silently clobbered by the
   *   generated index at the same path — silent page loss the collision guard
   *   (content paths only) never sees.
   */
  private writeStagedDoc(stagingDir: string, doc: OkfDocument): void {
    let relPath: string;
    let content: string;
    if (Object.keys(doc.frontmatter).length === 0) {
      assertSafeConceptId(doc.path);
      if (!RESERVED_BASENAMES.has(path.posix.basename(doc.path))) {
        throw new OkfPathError(
          `empty_frontmatter_nonindex: ${JSON.stringify(doc.path)} has empty frontmatter but is not a reserved index/log file`,
        );
      }
      relPath = doc.path;
      const body = doc.body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      content = body === '' ? '' : `${body}\n`;
    } else {
      ({ path: relPath, content } = renderOkfDocument(doc));
    }
    const abs = path.join(stagingDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /**
   * Finish a staged tree whose content documents are already on disk: run the
   * collision guard, generate + write the directory indexes (plain markdown),
   * write the root log and the marker sidecar. Returns the flat page count +
   * per-type breakdown derived from the staged document set.
   */
  private materializeStagedTree(
    stagingDir: string,
    contentDocs: OkfDocument[],
    opts: {
      generatedAt: string;
      inputsHash: string;
      mode: OkfBundleMode;
      priorLog: string | null;
      logSummary: string;
      generatedByRunRef: string | null;
      bundleGeneration: number;
      warnings: OkfMaintainWarning[];
    },
  ): { pageCount: number; byType: Record<string, number> } {
    // Collision guard reinstated from the deleted projectAllConcepts: two
    // document paths that collide after case-fold would clobber on a
    // case-insensitive filesystem. Same guard mutateConcepts runs, now on the
    // render-seam path too.
    const collisions = detectCollisions(contentDocs.map((d) => d.path.replace(/\.md$/, '')));
    if (collisions.length > 0) {
      throw new OkfError('concept_path_collision', `document path collision: ${[...new Set(collisions)].join(', ')}`);
    }

    // Deterministic directory indexes (empty frontmatter → plain markdown).
    for (const index of generateIndexes(contentDocs)) this.writeStagedDoc(stagingDir, index);

    const byType = this.byTypeOf(contentDocs);
    const pageCount = contentDocs.length;

    // Root log: prepend a dated entry (published) / rebuild snapshot (local).
    const priorEntries = opts.mode === 'published' ? this.parseLogEntries(opts.priorLog) : [];
    const date = opts.generatedAt.slice(0, 10);
    const entries: OkfLogEntry[] = [{ date, lines: [opts.logSummary] }, ...priorEntries];
    fs.writeFileSync(path.join(stagingDir, 'log.md'), renderRootLog(entries));

    // Marker / sidecar — ONE file carrying the full payload.
    fs.writeFileSync(
      path.join(stagingDir, OKF_MARKER_FILENAME),
      `${JSON.stringify(
        {
          generator: 'myco',
          okf_version: OKF_VERSION,
          project_ref: mycoProjectRef(this.deps.projectId),
          generated_at: opts.generatedAt,
          bundle_generation: opts.bundleGeneration,
          inputs_hash: opts.inputsHash,
          concept_count: pageCount,
          by_type: byType,
          generated_by_run_ref: opts.generatedByRunRef ?? undefined,
          warnings: opts.warnings.map((w) => ({ code: w.code, message: w.message, path: w.path })),
        },
        null,
        2,
      )}\n`,
    );

    return { pageCount, byType };
  }

  /** Group documents by (non-empty) OKF frontmatter `type`; unknown/blank → 'unknown'. */
  private byTypeOf(docs: ReadonlyArray<{ frontmatter: { type?: unknown } }>): Record<string, number> {
    const byType: Record<string, number> = {};
    for (const doc of docs) {
      const raw = doc.frontmatter.type;
      const type = typeof raw === 'string' && raw.trim() !== '' ? raw : 'unknown';
      byType[type] = (byType[type] ?? 0) + 1;
    }
    return byType;
  }

  private async writeConceptTree(stagingDir: string, concepts: OkfConcept[]): Promise<void> {
    for (let i = 0; i < concepts.length; i += 1) {
      const { path: relPath, content } = renderConcept(concepts[i]);
      const abs = path.join(stagingDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      if (i % RENDER_YIELD_EVERY === RENDER_YIELD_EVERY - 1) await yieldPoint();
    }
  }

  /**
   * Root-file writer for the concept-mutation path (`mutateConcepts`), which
   * still rebuilds the `OkfConcept` tree + frontmatter root index validated at
   * `myco_strict`. The Myco-shaped per-include-kind counts are gone: section
   * summaries and the marker's `by_type` are derived from the concept set.
   */
  private writeRootFiles(
    stagingDir: string,
    concepts: OkfConcept[],
    opts: {
      generatedAt: string;
      inputsHash: string;
      mode: OkfBundleMode;
      priorLog: string | null;
      prependLogLine: string;
      bundleGeneration: number;
      generatedByRunRef: string | null;
      warnings: OkfMaintainWarning[];
    },
  ): void {
    // Directory indexes (non-root indexes are plain markdown).
    const indexes = generateDirectoryIndexes(concepts);
    for (const [rel, content] of indexes) {
      if (rel === 'index.md') continue; // replaced by the frontmatter root index below
      const abs = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    // Root index with frontmatter + section summaries (one per top-level dir).
    const perDir = new Map<string, number>();
    for (const concept of concepts) {
      const top = concept.id.split('/', 1)[0];
      perDir.set(top, (perDir.get(top) ?? 0) + 1);
    }
    const sections = [...perDir.keys()].sort().map((dir) => {
      const n = perDir.get(dir)!;
      return { dir, summary: `${n} concept${n === 1 ? '' : 's'}.` };
    });
    fs.writeFileSync(
      path.join(stagingDir, 'index.md'),
      renderRootIndex({
        title: 'Myco Knowledge Bundle',
        description: 'Open Knowledge Format bundle generated from Myco project intelligence.',
        timestamp: opts.generatedAt,
        mycoProjectRef: mycoProjectRef(this.deps.projectId),
        inputsHash: opts.inputsHash,
        generatedByRunRef: opts.generatedByRunRef,
        sections,
      }),
    );

    // Root log: prepend a dated entry (published) / rebuild snapshot (local).
    const priorEntries = opts.mode === 'published' ? this.parseLogEntries(opts.priorLog) : [];
    const date = opts.generatedAt.slice(0, 10);
    const entries: OkfLogEntry[] = [{ date, lines: [opts.prependLogLine] }, ...priorEntries];
    fs.writeFileSync(path.join(stagingDir, 'log.md'), renderRootLog(entries));

    // Marker / sidecar — ONE file carrying the full payload.
    fs.writeFileSync(
      path.join(stagingDir, OKF_MARKER_FILENAME),
      `${JSON.stringify(
        {
          generator: 'myco',
          okf_version: OKF_VERSION,
          project_ref: mycoProjectRef(this.deps.projectId),
          generated_at: opts.generatedAt,
          bundle_generation: opts.bundleGeneration,
          inputs_hash: opts.inputsHash,
          concept_count: concepts.length,
          by_type: this.byTypeOf(concepts),
          warnings: opts.warnings.map((w) => ({ code: w.code, message: w.message, path: w.path })),
        },
        null,
        2,
      )}\n`,
    );
  }

  // -------------------------------------------------------------------
  // Atomic replacement + rollback
  // -------------------------------------------------------------------

  /** Returns true when the swap succeeded but backup cleanup is pending. */
  private atomicReplace(
    stagingDir: string,
    outputRoot: string,
    generation: number,
    manifest: OkfPrivateManifest | null,
  ): boolean {
    const exists = this.dirExists(outputRoot);
    const backup = exists ? path.join(this.deps.vault.okfStateDir(), `backup-${generation}`) : null;

    // Step 11: move the live bundle aside (skip on first publish).
    if (backup) {
      if (this.dirExists(backup)) this.safeRm(backup);
      try {
        this.renameWithRetry(outputRoot, backup);
      } catch (err) {
        // Nothing moved yet — the previous bundle is intact.
        this.persistLastResult(manifest, 'rolled_back');
        throw new OkfError('atomic_replace_failed', `backup rename failed (${errCode(err)})`, {
          lastResult: 'rolled_back',
        });
      }
    }

    // Step 12: swap staging into place.
    try {
      this.fsOps.mkdir(path.dirname(outputRoot), { recursive: true });
      this.renameWithRetry(stagingDir, outputRoot);
    } catch (err) {
      const lastResult = this.rollback(backup, outputRoot);
      this.persistLastResult(manifest, lastResult);
      throw new OkfError('atomic_replace_failed', `final rename failed (${errCode(err)})`, { lastResult });
    }

    // Step 13: remove the backup.
    if (backup) {
      try {
        this.fsOps.rm(backup, { recursive: true, force: true });
      } catch {
        return true; // cleanup_pending — swept next run
      }
    }
    return false;
  }

  /** Restore the previous bundle; returns the manifest last_result. */
  private rollback(backup: string | null, outputRoot: string): 'rolled_back' | 'rollback_failed' {
    try {
      // Remove any partial final left by a half-completed rename.
      if (this.dirExists(outputRoot)) this.fsOps.rm(outputRoot, { recursive: true, force: true });
      if (backup) this.fsOps.rename(backup, outputRoot);
      return 'rolled_back';
    } catch {
      return 'rollback_failed';
    }
  }

  private renameWithRetry(from: string, to: string): void {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
      try {
        this.fsOps.rename(from, to);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        // Windows: editors/indexers briefly hold directory handles → EPERM/EBUSY.
        if (code !== 'EPERM' && code !== 'EBUSY') throw err;
        // Busy-wait a short spin between attempts (sync path inside the lock).
        const until = Date.now() + RENAME_RETRY_MS;
        while (Date.now() < until) { /* spin */ }
      }
    }
    throw lastErr;
  }

  private persistLastResult(manifest: OkfPrivateManifest | null, lastResult: OkfPrivateManifest['last_result']): void {
    const base: OkfPrivateManifest = manifest ?? {
      bundle_generation: 0,
      inputs_hash: null,
      output_root: '',
      last_result: null,
      generated_at: null,
      acknowledged_findings: [],
      probe_fingerprint: null,
      last_run_ref: null,
    };
    this.deps.vault.writeOkfManifest({ ...base, last_result: lastResult });
  }

  // -------------------------------------------------------------------
  // Manifest recovery + housekeeping
  // -------------------------------------------------------------------

  private reconcileManifestForRoot(
    manifest: OkfPrivateManifest | null,
    outputRoot: string,
    warnings: OkfMaintainWarning[],
  ): OkfPrivateManifest | null {
    if (!manifest || manifest.output_root === outputRoot || manifest.output_root === '') return manifest;
    warnings.push({
      code: 'output_root_changed',
      message: `output root changed from ${manifest.output_root} to ${outputRoot}; the previous bundle is orphaned (not deleted).`,
      path: manifest.output_root,
    });
    // Treat as first publish of the new root — reset generation/hash/acks.
    return null;
  }

  /**
   * Restore a bundle orphaned by a crash between atomicReplace's two renames:
   * the live bundle was moved to `backup-{N+1}` but staging was not yet swapped
   * into `outputRoot`, so the backup holds the only copy. Restore it BEFORE any
   * sweep deletes it. Idempotent — a no-op when the live bundle is present.
   */
  private recoverOrphanedBundle(outputRoot: string, warnings: OkfMaintainWarning[]): void {
    if (this.markerExists(outputRoot)) return;
    const stateDir = this.deps.vault.okfStateDir();
    let best: { path: string; gen: number } | null = null;
    for (const name of this.safeReaddir(stateDir)) {
      if (!name.startsWith('backup-')) continue;
      const backupPath = path.join(stateDir, name);
      const gen = this.readMarkerGeneration(backupPath);
      if (gen === null) continue; // incomplete backup — no marker, skip
      if (!best || gen > best.gen) best = { path: backupPath, gen };
    }
    if (!best) return;
    try {
      // Clear any partial/empty outputRoot the interrupted swap left behind first.
      if (this.dirExists(outputRoot)) this.fsOps.rm(outputRoot, { recursive: true, force: true });
      this.fsOps.mkdir(path.dirname(outputRoot), { recursive: true });
      this.renameWithRetry(best.path, outputRoot);
      warnings.push({
        code: 'crash_recovery',
        message: `restored the previous bundle from ${path.basename(best.path)} after an interrupted publish.`,
      });
    } catch {
      // Restore failed — leave the backup in place; the regenerate path rebuilds
      // from the vault and the backup is swept on the next successful publish.
    }
  }

  /** Adopt the published marker's generation when it exceeds the manifest's. */
  private reconcileGenerationWithMarker(
    manifest: OkfPrivateManifest | null,
    outputRoot: string,
  ): OkfPrivateManifest | null {
    if (!manifest) return manifest;
    const markerGen = this.readMarkerGeneration(outputRoot);
    if (markerGen !== null && markerGen > manifest.bundle_generation) {
      return { ...manifest, bundle_generation: markerGen };
    }
    return manifest;
  }

  private recoverFromCrash(
    manifest: OkfPrivateManifest | null,
    outputRoot: string,
    warnings: OkfMaintainWarning[],
  ): OkfPrivateManifest | null {
    const reconciled = this.reconcileGenerationWithMarker(manifest, outputRoot);
    if (reconciled !== manifest && reconciled) {
      warnings.push({
        code: 'crash_recovery',
        message: `published marker generation ${reconciled.bundle_generation} exceeds the manifest; adopting the marker's value.`,
      });
    }
    return reconciled;
  }

  /**
   * Reconcile the ownership file to the on-disk generation. A crash between
   * an atomic-replace and the ownership write (whether or not the manifest
   * write itself landed) leaves ownership missing or stamped with a stale
   * `bundleGeneration` — recompute every page's fingerprint from the tree
   * actually on disk and persist it. Skipped when ownership already reflects
   * the published marker's generation: at that point any fingerprint mismatch
   * is a genuine hand-edit (what `isHandEdited` exists to detect), and this
   * check must never clobber it.
   */
  private reconcileOwnershipForRoot(outputRoot: string, warnings: OkfMaintainWarning[]): void {
    const markerGen = this.readMarkerGeneration(outputRoot);
    if (markerGen === null) return; // no published bundle at this root yet
    const existing = this.deps.vault.readOkfOwnership();
    if (existing && existing.bundleGeneration === markerGen) return; // already caught up

    const marker = this.readMarker(outputRoot);
    const generatedAt = typeof marker?.generated_at === 'string' ? marker.generated_at : this.now().toISOString();
    this.deps.vault.writeOkfOwnership(this.computeOwnershipFromTree(outputRoot, markerGen, generatedAt));
    warnings.push({
      code: 'crash_recovery',
      message: `ownership fingerprints reconciled to bundle generation ${markerGen} after an interrupted publish.`,
    });
  }

  /**
   * Fingerprint every currently-published content page under `outputRoot` —
   * the same non-reserved-`.md` walk `derivePageStats`/`listConcepts` use,
   * skipping generated index/log files. The single computation both the
   * `finalize` write path and crash-recovery reconciliation share, so the two
   * can never disagree on what "the published page content" hashes to.
   */
  private computeOwnershipFromTree(outputRoot: string, bundleGeneration: number, generatedAt: string): OkfOwnership {
    const pages: OkfOwnership['pages'] = {};
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(relDir === '' ? outputRoot : path.join(outputRoot, relDir)).sort()) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(outputRoot, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        try {
          const content = fs.readFileSync(abs, 'utf8');
          pages[rel] = { fingerprint: sha256Hex(content), generatedAt };
        } catch {
          /* skip unreadable */
        }
      }
    };
    walk('');
    return { bundleGeneration, pages };
  }

  private sweepStale(manifest: OkfPrivateManifest | null, warnings: OkfMaintainWarning[]): void {
    const stateDir = this.deps.vault.okfStateDir();
    // Sweep stale backups.
    for (const name of this.safeReaddir(stateDir)) {
      if (name.startsWith('backup-')) this.safeRm(path.join(stateDir, name));
    }
    // Sweep stale staging dirs.
    const stagingRoot = this.deps.vault.okfStagingDir();
    for (const name of this.safeReaddir(stagingRoot)) {
      this.safeRm(path.join(stagingRoot, name));
    }
    if (manifest?.last_result === 'cleanup_pending') {
      warnings.push({ code: 'cleanup_recovered', message: 'recovered a prior cleanup_pending state during sweep.' });
    }
  }

  /** A finding is acknowledged only when a prior ack matches its (code, path, hash). */
  private findingAcknowledged(
    finding: { code: string; path: string; hash: string },
    acknowledged: ReadonlyArray<{ code: string; path: string; hash?: string }>,
  ): boolean {
    return acknowledged.some((a) => a.code === finding.code && a.path === finding.path && a.hash === finding.hash);
  }

  private mergeAcknowledgements(
    manifest: OkfPrivateManifest | null,
    findings: ReturnType<typeof scanStagedBundle>,
    isPublished: boolean,
    acknowledge: boolean,
  ): Array<{ code: string; path: string; hash?: string }> {
    const existing = manifest?.acknowledged_findings ?? [];
    if (!isPublished || !acknowledge) return existing;
    const merged = [...existing];
    for (const f of findings) {
      if (!this.findingAcknowledged(f, merged)) merged.push({ code: f.code, path: f.path, hash: f.hash });
    }
    return merged;
  }

  private computeProbeFingerprint(gathered: OkfGatherResult, input: OkfBundleWriteInput): string {
    const maxSporeUpdate = gathered.spores.reduce((m, s) => Math.max(m, s.updated_at ?? s.created_at), 0);
    const maxCanopyUpdate = gathered.canopyEntries.reduce((m, e) => Math.max(m, e.llm_updated_at ?? e.mechanical_updated_at), 0);
    return computeOkfProbeFingerprint({
      sporeCount: gathered.spores.length,
      maxSporeUpdate,
      canopyCount: gathered.canopyEntries.length,
      maxCanopyUpdate,
      conceptCount: gathered.conceptFiles.length,
      mapHash: gathered.canopyMap?.inputs_hash ?? null,
      include: this.effectiveInclude(input.include),
      sporeStatus: input.sporeStatus,
    });
  }

  // -------------------------------------------------------------------
  // status / validate / list / get
  // -------------------------------------------------------------------

  status(): OkfBundleStatus {
    const resolved = this.resolve({ mode: 'published' });
    const outputRoot = resolved.absPath;
    // Reconcile in-memory (no write from a read path) so a crash-lagged manifest
    // reports the marker's true generation.
    const manifest = this.reconcileGenerationWithMarker(this.deps.vault.readOkfManifest(), outputRoot);
    const marker = this.readMarker(outputRoot);
    const bundleExists = marker !== null;

    // Stale = the current gather-probe hash differs from the manifest's.
    let stale = false;
    if (manifest?.inputs_hash) {
      try {
        const probe = gather(
          {
            projectRoot: this.deps.projectRoot,
            scope: this.deps.scope,
            projectId: this.deps.projectId,
            machineId: this.deps.machineId,
            config: this.deps.config,
            outputRoot,
          },
          {
            include: this.effectiveInclude(),
            // Mirror the config-driven maintain the scheduled task will run: a
            // single 'active' status maps to the 'active' filter, any broader
            // set to 'all'. Prevents a false-stale for non-default configs.
            sporeStatus: this.configuredSporeStatus(),
            // Fixed constant, not config-driven — `include_undescribed_canopy`
            // was retired from the schema by Task 4.2; reproduces its old default.
            includeUndescribedCanopy: false,
          },
        );
        stale = probe.inputsHash !== manifest.inputs_hash;
      } catch {
        stale = false;
      }
    }

    // Flat page count + per-type breakdown are derived from the published tree,
    // not the marker — the tree is the truth after any concept-mutation edit.
    const stats = bundleExists ? this.derivePageStats(outputRoot) : null;

    return {
      outputRoot,
      bundleExists,
      bundleGeneration: manifest?.bundle_generation ?? null,
      inputsHash: manifest?.inputs_hash ?? null,
      generatedAt: manifest?.generated_at ?? null,
      lastResult: manifest?.last_result ?? null,
      byType: stats?.byType ?? null,
      conceptCount: stats?.pageCount ?? null,
      stale,
      publishAcknowledged: this.derivePublishAcknowledged(manifest, outputRoot),
    };
  }

  validate(outputRoot?: string): OkfValidationReport {
    const root = outputRoot ?? this.resolve({ mode: 'published' }).absPath;
    return validateBundleTree(root, 'strict');
  }

  /**
   * Flat page count + per-OKF-type breakdown of a published tree, walking every
   * non-reserved `.md` (excluding `index.md`/`log.md`). Derived from disk so it
   * stays true after a concept-mutation edit the marker doesn't reflect.
   */
  private derivePageStats(outputRoot: string): { pageCount: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    let pageCount = 0;
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(relDir === '' ? outputRoot : path.join(outputRoot, relDir)).sort()) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(outputRoot, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        pageCount += 1;
        try {
          const { frontmatter } = parseConceptDoc(fs.readFileSync(abs, 'utf8'));
          const raw = frontmatter.type;
          const type = typeof raw === 'string' && raw.trim() !== '' ? raw : 'unknown';
          byType[type] = (byType[type] ?? 0) + 1;
        } catch {
          byType.unknown = (byType.unknown ?? 0) + 1;
        }
      }
    };
    walk('');
    return { pageCount, byType };
  }

  listConcepts(): OkfConceptSummary[] {
    const root = this.resolve({ mode: 'published' }).absPath;
    const conceptsDir = path.join(root, 'concepts');
    const out: OkfConceptSummary[] = [];
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(path.join(conceptsDir, relDir)).sort()) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(conceptsDir, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        try {
          const { frontmatter } = parseConceptDoc(fs.readFileSync(abs, 'utf8'));
          out.push({
            id: `concepts/${rel.slice(0, -'.md'.length)}`,
            type: typeof frontmatter.type === 'string' ? frontmatter.type : 'unknown',
            title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
            status: typeof frontmatter.status === 'string' ? frontmatter.status : undefined,
            updatedAt: typeof frontmatter.timestamp === 'string' ? frontmatter.timestamp : undefined,
          });
        } catch {
          /* skip unparseable */
        }
      }
    };
    walk('');
    return out;
  }

  getConcept(id: string): { concept: OkfConcept; raw: string } | null {
    const root = this.resolve({ mode: 'published' }).absPath;
    let rel: string;
    let raw: string;
    try {
      // conceptPathForId rejects a traversal id; an unsafe or unreadable id is
      // reported as "not found" so no file outside the bundle is disclosed.
      rel = conceptPathForId(id);
      raw = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
    const { frontmatter, body } = parseConceptDoc(raw);
    return {
      raw,
      concept: {
        id,
        path: rel,
        frontmatter: frontmatter as OkfConcept['frontmatter'],
        body,
        source: { id, projectId: null },
        links: [],
      },
    };
  }

  /**
   * List published OKF v0.1 document pages — every non-reserved `.md` in the
   * published tree (excluding `index.md`/`log.md`), each with its
   * bundle-relative path and OKF frontmatter `type`/`title`. The document-model
   * read primitive for the synthesis harness (`okf_list_pages`); unlike
   * `listConcepts`, it walks the whole tree, not just `concepts/`, because
   * Phase 2 documents live at arbitrary bundle-relative paths.
   */
  listPages(): Array<{ path: string; type: string; title?: string; description?: string; timestamp?: string }> {
    const root = this.resolve({ mode: 'published' }).absPath;
    const out: Array<{ path: string; type: string; title?: string; description?: string; timestamp?: string }> = [];
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(relDir === '' ? root : path.join(root, relDir)).sort()) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(root, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        try {
          const { frontmatter } = parseConceptDoc(fs.readFileSync(abs, 'utf8'));
          out.push({
            path: rel,
            type: typeof frontmatter.type === 'string' ? frontmatter.type : 'unknown',
            title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
            description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
            timestamp: typeof frontmatter.timestamp === 'string' ? frontmatter.timestamp : undefined,
          });
        } catch {
          /* skip unparseable */
        }
      }
    };
    walk('');
    return out;
  }

  /**
   * Read one published document page's raw markdown by bundle-relative path
   * (with or without the `.md` suffix). Returns null for a missing, unsafe, or
   * unreadable path — an unsafe path is reported as "not found" so no file
   * outside the bundle is ever disclosed. Reserved index/log files are not pages.
   */
  readPage(pagePath: string): { path: string; raw: string } | null {
    const root = this.resolve({ mode: 'published' }).absPath;
    const rel = pagePath.endsWith('.md') ? pagePath : `${pagePath}.md`;
    try {
      assertSafeConceptId(rel);
    } catch {
      return null;
    }
    if (RESERVED_BASENAMES.has(path.posix.basename(rel))) return null;
    try {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      return { path: rel, raw };
    } catch {
      return null;
    }
  }

  /**
   * Read one published document page's parsed shape — OKF frontmatter
   * fields plus the rendered-markdown body — by bundle-relative path. The
   * document-model read primitive behind `/api/okf/pages/*`
   * (`handleOkfPageGet`) and the `myco_okf` MCP `get` op. Sibling to
   * {@link readPage} (which stays the raw-content primitive the synthesis
   * harness's refine-not-clobber flow needs): this one additionally parses
   * frontmatter, so a hand-edited page with malformed frontmatter falls
   * through to `null` — same "unsafe/unreadable/unparseable is reported as
   * not found" posture as {@link getConcept}.
   */
  getPage(
    pagePath: string,
  ): { path: string; type: string; title?: string; description?: string; timestamp?: string; body: string } | null {
    const got = this.readPage(pagePath);
    if (!got) return null;
    try {
      const { frontmatter, body } = parseConceptDoc(got.raw);
      return {
        path: got.path,
        type: typeof frontmatter.type === 'string' ? frontmatter.type : 'unknown',
        title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
        description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
        timestamp: typeof frontmatter.timestamp === 'string' ? frontmatter.timestamp : undefined,
        body,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Concept mutation
  // -------------------------------------------------------------------

  async saveConcept(input: SaveOkfConceptInput): Promise<SaveOkfConceptResult> {
    return this.mutateConcepts(
      input.expectedGeneration,
      (concepts, generatedAt, mode) => {
        const stamped = this.stampProvenance(input.markdown, input.provenance, mode);
        this.assertEditableConceptId(input.id);
        const issues = validateConceptSource(stamped, conceptPathForId(input.id), 'myco_strict').filter(
          (i) => i.level === 'error',
        );
        if (issues.length > 0) {
          throw new OkfError('okf_validation_failed', 'concept failed myco_strict validation', { issues });
        }
        const { frontmatter, body } = parseConceptDoc(stamped);
        const next = this.upsertConcept(concepts, input.id, frontmatter, body);
        return { concepts: next, logLine: `Saved concept ${input.id}.` };
      },
    ).then((generation) => ({
      id: input.id,
      bundleGeneration: generation,
      validation: { ok: true, level: 'myco_strict', filesChecked: 0, conceptsChecked: 0, issues: [] },
    }));
  }

  async supersedeConcept(input: SupersedeOkfConceptInput): Promise<SupersedeOkfConceptResult> {
    const generation = await this.mutateConcepts(input.expectedGeneration, (concepts) => {
      this.assertEditableConceptId(input.oldId);
      const old = concepts.find((c) => c.id === input.oldId);
      if (!old) throw new OkfError('okf_validation_failed', `concept ${input.oldId} does not exist`);
      if (!concepts.some((c) => c.id === input.newId)) {
        throw new OkfError('okf_validation_failed', `replacement concept ${input.newId} does not exist`);
      }
      const frontmatter = { ...old.frontmatter, status: 'superseded', superseded_by: input.newId };
      const relHref = path.posix.relative(path.posix.dirname(conceptPathForId(input.oldId)), conceptPathForId(input.newId));
      const body = `${old.body}\n\n## Superseded\n\n- Superseded by [${input.newId}](${relHref}) — ${input.reason}`;
      const next = this.upsertConcept(concepts, input.oldId, frontmatter, body);
      return { concepts: next, logLine: `Superseded ${input.oldId} by ${input.newId}: ${input.reason}` };
    });
    return { oldId: input.oldId, newId: input.newId, bundleGeneration: generation };
  }

  /**
   * Shared concept-mutation transaction: reconstruct the full concept set from
   * the published tree, apply a mutation, re-stage a COMPLETE bundle, and swap
   * atomically. Reconstruct-and-re-render is byte-stable for untouched
   * concepts (Plan 1 round-trip guarantee), so only the mutated concept, the
   * affected indexes, the log, and the marker change.
   */
  private async mutateConcepts(
    expectedGeneration: number | undefined,
    mutate: (
      concepts: OkfConcept[],
      generatedAt: string,
      mode: OkfBundleMode,
    ) => { concepts: OkfConcept[]; logLine: string },
  ): Promise<number> {
    const resolved = this.resolve({ mode: 'published' });
    if (resolved.klass === 'published_default' && !capabilityEnabled(this.deps.config, 'okf')) {
      throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
    }
    const outputRoot = resolved.absPath;
    const lock = await this.acquireLock();
    try {
      // Heal a crash-orphaned bundle before we require one to exist, and adopt
      // the marker's generation so a stale manifest can't reissue a used number.
      this.recoverOrphanedBundle(outputRoot, []);
      const manifest = this.reconcileGenerationWithMarker(this.deps.vault.readOkfManifest(), outputRoot);
      this.reconcileOwnershipForRoot(outputRoot, []);
      if (!this.markerExists(outputRoot)) {
        throw new OkfError('okf_maintain_failed', 'no published bundle to edit; run maintain first');
      }
      if (expectedGeneration !== undefined && manifest && manifest.bundle_generation !== expectedGeneration) {
        throw new OkfError('okf_generation_conflict', 'bundle generation changed since read', {
          currentGeneration: manifest.bundle_generation,
        });
      }

      const generatedAt = this.now().toISOString();
      const existing = this.reconstructConceptSet(outputRoot);
      const { concepts, logLine } = mutate(existing, generatedAt, 'published');
      const collisions = detectCollisions(concepts.map((c) => c.id));
      if (collisions.length > 0) {
        throw new OkfError('concept_path_collision', `concept id collision: ${[...new Set(collisions)].join(', ')}`);
      }

      this.sweepStale(manifest, []);
      const stagingDir = this.freshStagingDir();
      try {
        const nextGeneration = (manifest?.bundle_generation ?? 0) + 1;
        await this.writeConceptTree(stagingDir, concepts);
        this.writeRootFiles(stagingDir, concepts, {
          generatedAt,
          inputsHash: manifest?.inputs_hash ?? '',
          mode: 'published',
          priorLog: this.readRootLog(outputRoot),
          prependLogLine: logLine,
          bundleGeneration: nextGeneration,
          generatedByRunRef: null,
          warnings: [],
        });

        const findings = scanStagedBundle(stagingDir);
        const acknowledged = manifest?.acknowledged_findings ?? [];
        const unacked = findings.filter((f) => !this.findingAcknowledged(f, acknowledged));
        if (unacked.length > 0) {
          throw new OkfError('okf_publish_not_acknowledged', 'concept edit introduced unacknowledged findings', {
            findings: unacked,
          });
        }
        const validation = validateBundleTree(stagingDir, 'myco_strict', { mode: 'published' });
        if (!validation.ok) {
          throw new OkfError('okf_validation_failed', 'edited bundle failed myco_strict validation', { validation });
        }

        this.assertSameFilesystem(stagingDir, outputRoot);
        const cleanupPending = this.atomicReplace(stagingDir, outputRoot, nextGeneration, manifest);
        this.deps.vault.writeOkfManifest({
          bundle_generation: nextGeneration,
          inputs_hash: manifest?.inputs_hash ?? null,
          output_root: outputRoot,
          last_result: cleanupPending ? 'cleanup_pending' : 'published',
          generated_at: generatedAt,
          acknowledged_findings: acknowledged,
          probe_fingerprint: manifest?.probe_fingerprint ?? null,
          last_run_ref: manifest?.last_run_ref ?? null,
        });
        // Ownership follows the manifest write here too — a concept edit
        // republishes the whole tree, so every page's fingerprint moves to this
        // generation (reconstruct-and-re-render is byte-stable for untouched
        // concepts, so only the edited concept's fingerprint actually changes).
        this.deps.vault.writeOkfOwnership(this.computeOwnershipFromTree(outputRoot, nextGeneration, generatedAt));
        return nextGeneration;
      } finally {
        this.safeRm(stagingDir);
      }
    } finally {
      this.releaseLock(lock);
    }
  }

  private assertEditableConceptId(id: string): void {
    if (!id.startsWith('concepts/')) {
      throw new OkfError('deterministic_path_not_editable', `${id} is not under concepts/ and cannot be edited`);
    }
    // Reject traversal within the concepts/ namespace ('concepts/../../x'),
    // and any segment outside the okfSlug charset assertSafeConceptId enforces.
    try {
      assertSafeConceptId(id);
    } catch {
      throw new OkfError('deterministic_path_not_editable', `${id} contains an unsafe path segment and cannot be edited`);
    }
  }

  private stampProvenance(markdown: string, provenance: OkfConceptProvenance, mode: OkfBundleMode): string {
    const { frontmatter, body } = parseConceptDoc(markdown);
    const stamp: Record<string, unknown> = { actor: provenance.actor };
    if (mode === 'published') {
      if (provenance.sessionRef) stamp.session_ref = runRef(provenance.sessionRef);
      if (provenance.runRef) stamp.run_ref = runRef(provenance.runRef);
    } else {
      if (provenance.sessionRef) stamp.session_ref = provenance.sessionRef;
      if (provenance.runRef) stamp.run_ref = provenance.runRef;
    }
    return serializeConceptDoc({ ...frontmatter, myco_provenance: stamp }, body);
  }

  private upsertConcept(
    concepts: OkfConcept[],
    id: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): OkfConcept[] {
    const replacement: OkfConcept = {
      id,
      path: conceptPathForId(id),
      frontmatter: frontmatter as OkfConcept['frontmatter'],
      body,
      source: { sourceKind: 'okf_concept', id, projectId: null },
      links: [],
    };
    const idx = concepts.findIndex((c) => c.id === id);
    if (idx === -1) return [...concepts, replacement];
    const next = concepts.slice();
    next[idx] = replacement;
    return next;
  }

  /** Reconstruct every concept in the published tree as re-renderable OkfConcepts. */
  private reconstructConceptSet(outputRoot: string): OkfConcept[] {
    const out: OkfConcept[] = [];
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(path.join(outputRoot, relDir)).sort()) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(outputRoot, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        try {
          const { frontmatter, body } = parseConceptDoc(fs.readFileSync(abs, 'utf8'));
          const id = rel.slice(0, -'.md'.length);
          out.push({
            id,
            path: rel,
            frontmatter: frontmatter as OkfConcept['frontmatter'],
            body,
            source: { id, projectId: null },
            links: [],
          });
        } catch {
          /* skip unparseable — validation on re-stage will catch structural issues */
        }
      }
    };
    walk('');
    return out;
  }

  // -------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------

  private unchangedResult(
    outputRoot: string,
    manifest: OkfPrivateManifest,
    gathered: OkfGatherResult,
  ): OkfBundleWriteResult {
    const stats = this.derivePageStats(outputRoot);
    return {
      outputRoot,
      dryRun: false,
      generatedAt: manifest.generated_at ?? this.now().toISOString(),
      conceptCount: stats.pageCount,
      byType: stats.byType,
      warnings: gathered.warnings,
      validation: { ok: true, level: 'strict', filesChecked: 0, conceptsChecked: 0, issues: [] },
      inputsHash: gathered.inputsHash,
      unchanged: true,
    };
  }

  private derivePublishAcknowledged(manifest: OkfPrivateManifest | null, outputRoot: string): boolean {
    if (!manifest) return true;
    if (!this.markerExists(outputRoot)) return true;
    const findings = scanStagedBundle(outputRoot);
    const ack = manifest.acknowledged_findings;
    return findings.every((f) => this.findingAcknowledged(f, ack));
  }

  private freshStagingDir(): string {
    const root = this.deps.vault.okfStagingDir();
    const name = `stage-${process.pid}-${sha256Hex(`${this.now().toISOString()}-${Math.floor(this.now().getTime())}`).slice(0, 12)}`;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Copy every currently-published content page into a fresh staging dir so
   * an incremental run that only re-stages a SUBSET of pages doesn't drop the
   * rest at finalize's atomic-replace — the synthesis plan caps a run at ~30
   * pages and drains across runs, leaving untouched pages as-is. A no-op when
   * nothing is published yet at `outputRoot` (first run) or the root doesn't
   * carry a Myco marker for this project (never adopt a foreign tree's pages
   * via `overwrite`). Reserved index/log files are skipped —
   * `materializeStagedTree` always regenerates them from the full
   * content-doc set.
   *
   * Parses each copied page into `carried` (bundle-relative path →
   * OkfDocument) so `finalize` can fold it into the content-doc list
   * `generateIndexes`/`byTypeOf`/the collision guard see — those only see
   * what THIS run's `stageDocument` calls pushed, not what's physically
   * sitting in the staging dir. A page that fails to parse is still copied to
   * disk (never lost) but absent from `carried` — the same best-effort the
   * reconstruct-and-re-render concept-mutation path (`reconstructConceptSet`)
   * already accepts.
   */
  private seedStagingFromPublished(stagingDir: string, outputRoot: string, carried: Map<string, OkfDocument>): void {
    if (!this.markerExists(outputRoot)) return;
    const walk = (relDir: string): void => {
      for (const name of this.safeReaddir(relDir === '' ? outputRoot : path.join(outputRoot, relDir))) {
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const abs = path.join(outputRoot, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.md') || RESERVED_BASENAMES.has(name)) continue;
        let raw: string;
        try {
          raw = fs.readFileSync(abs, 'utf8');
        } catch {
          continue; // unreadable — nothing to carry forward
        }
        const dest = path.join(stagingDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, raw);
        try {
          const { frontmatter, body } = parseConceptDoc(raw);
          carried.set(rel, { path: rel, frontmatter: frontmatter as OkfDocument['frontmatter'], body });
        } catch {
          /* unparseable — file is still carried forward on disk, just absent from generated indexes */
        }
      }
    };
    walk('');
  }

  private assertOutputWritable(outputRoot: string, overwrite: boolean): void {
    if (!this.dirExists(outputRoot)) return;
    const marker = this.readMarker(outputRoot);
    if (!marker) {
      const nonEmpty = fs.readdirSync(outputRoot).length > 0;
      if (nonEmpty && !overwrite) {
        throw new OkfError('non_myco_output_present', 'output root exists with non-Myco content; pass overwrite to replace it');
      }
      return;
    }
    // Marker present but a foreign project_ref → template-clone protection.
    if (marker.project_ref !== mycoProjectRef(this.deps.projectId) && !overwrite) {
      throw new OkfError('non_myco_output_present', 'output root belongs to a different Myco project; pass overwrite to adopt it');
    }
  }

  private assertSameFilesystem(stagingDir: string, outputRoot: string): void {
    const parent = path.dirname(outputRoot);
    try {
      const stagingDev = this.fsOps.stat(stagingDir).dev;
      const parentDev = this.fsOps.stat(this.dirExists(parent) ? parent : path.dirname(parent)).dev;
      if (process.platform === 'win32' && (stagingDev === 0 || parentDev === 0)) return; // advisory on win32
      if (stagingDev !== parentDev) {
        throw new OkfError('atomic_replace_failed', 'staging and output are on different filesystems; atomic rename impossible', {
          lastResult: 'rolled_back',
        });
      }
    } catch (err) {
      if (err instanceof OkfError) throw err;
      // stat failure is non-fatal — the rename itself will surface a real error.
    }
  }

  private markerExists(outputRoot: string): boolean {
    return fs.existsSync(path.join(outputRoot, OKF_MARKER_FILENAME));
  }

  private readMarker(outputRoot: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(outputRoot, OKF_MARKER_FILENAME), 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private readMarkerGeneration(outputRoot: string): number | null {
    const marker = this.readMarker(outputRoot);
    const gen = marker?.bundle_generation;
    return typeof gen === 'number' ? gen : null;
  }

  private readRootLog(outputRoot: string): string | null {
    try {
      return fs.readFileSync(path.join(outputRoot, 'log.md'), 'utf8');
    } catch {
      return null;
    }
  }

  private parseLogEntries(log: string | null): OkfLogEntry[] {
    if (!log) return [];
    const entries: OkfLogEntry[] = [];
    let current: OkfLogEntry | null = null;
    for (const line of log.split('\n')) {
      const header = /^## (.+)$/.exec(line);
      if (header) {
        current = { date: header[1].trim(), lines: [] };
        entries.push(current);
        continue;
      }
      const bullet = /^- (.+)$/.exec(line);
      if (bullet && current) current.lines.push(bullet[1]);
    }
    return entries;
  }

  private dirExists(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  private safeReaddir(target: string): string[] {
    try {
      return fs.readdirSync(target);
    } catch {
      return [];
    }
  }

  private safeRm(target: string): void {
    try {
      this.fsOps.rm(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Errno code only — never the OS error message, which embeds absolute paths. */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'unknown';
}
