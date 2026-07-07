import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import type { ProjectVault, OkfPrivateManifest } from '@myco/vault/project-vault.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import type { OkfOwnership } from './ownership.js';
import { OkfError } from './errors.js';
import { resolveOutputRoot, type OutputClass } from './output-root.js';
import { mycoProjectRef, runRef } from './privacy.js';
import { assertSafeConceptId, conceptPathForId, detectCollisions, OkfPathError } from './paths.js';
import { parseConceptDoc, serializeConceptDoc } from './frontmatter.js';
import { renderConcept, renderOkfDocument, renderRootIndex, renderRootLog, type OkfLogEntry } from './serialize.js';
import { generateDirectoryIndexes, generateIndexes } from './indexes.js';
import { validateBundleTree, validateConceptSource, validateOkfDocumentFile } from './validate.js';
import { scanStagedBundle } from './publish-eligibility.js';
import {
  OKF_MARKER_FILENAME,
  OKF_RESERVED_FILES,
  OKF_VERSION,
  type OkfBundleMode,
  type OkfBundleWriteInput,
  type OkfBundleWriteResult,
  type OkfConcept,
  type OkfDocument,
  type OkfMaintainWarning,
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
  pageCount: number | null;
  publishAcknowledged: boolean;
  /**
   * Findings that blocked the most recent synthesis publish (from
   * `manifest.pending_findings`), surfaced so the OKF page's load-time
   * publish-block panel lights up on a plain reload after a blocked run.
   * Empty when nothing is pending. Drained by `acknowledgePendingFindings`.
   */
  pendingFindings: Array<{ code: string; path: string; hash?: string }>;
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
  ): Promise<StagedGeneration> {
    const resolved = this.resolve({
      mode: input.mode,
      outputRoot: input.outputRoot,
      allowExternalOutput: input.allowExternalOutput,
    });
    if (resolved.klass === 'external_export') {
      throw new OkfError(
        'okf_maintain_failed',
        'staged generation does not support external export',
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
    // Every carried page's bundle-relative path (parseable OR not) — the
    // quarantine pass in finalize per-file-validates each and drops any that
    // would sink the whole-tree strict validate. A superset of
    // carriedForwardDocs' keys: an unparseable carried page is on disk (and
    // here) but absent from carriedForwardDocs.
    const carriedForwardPaths = new Set<string>();

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
      if (carryForward) this.seedStagingFromPublished(stagingDir, outputRoot, carriedForwardDocs, carriedForwardPaths);
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

        // Quarantine carried pages that fail per-file strict validation so one
        // human-broken carried page (malformed frontmatter, a dropped floor key)
        // can't wedge EVERY future publish by sinking the whole-tree strict
        // validate below. Only pages this run did NOT re-stage are checked — a
        // page re-synthesized fresh this run has its fresh content validated by
        // the whole-tree pass, and that content wins over the seeded copy. A
        // quarantined page is excluded from the staged tree (so the scan, the
        // strict validate, and the atomic-replace never see it), from the
        // regenerated indexes, and from ownership re-fingerprinting; a warning
        // makes it recoverable. It is NOT destroyed in place — it lingers in the
        // still-live prior bundle until this publish's atomic-replace drops it.
        this.quarantineInvalidCarriedPages(dir, carriedForwardPaths, stagedPaths, carriedForwardDocs, input.mode, warnings);

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
            // Persist the blocking findings to the manifest BEFORE aborting, so
            // the block survives this ephemeral run's teardown: the synthesis
            // staged tree is dropped and nothing is published, but the OKF page
            // (via status.pendingFindings) can surface the block on a plain
            // reload and `POST /api/okf/acknowledge` can drain it. This is a
            // MANIFEST-ONLY write — it does NOT publish the staged tree, and the
            // run still fails exactly as before.
            this.persistPendingFindings(manifest, unacked, outputRoot);
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
          pageCount,
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
          // A successful publish clears any prior block: we only reach here when
          // no unacknowledged finding remained (or the caller acknowledged), so
          // nothing is pending.
          pending_findings: [],
          probe_fingerprint: opts?.probeFingerprint ?? null,
          // Preserve the prior manifest's baseline when this caller doesn't
          // provide one — a publish that doesn't recompute the
          // `okf-synthesize-due` baseline must not silently erase what a prior
          // synthesize run recorded.
          last_run_ref: opts?.lastRunRef ?? manifest?.last_run_ref ?? null,
        });
        // Ownership — manifest-adjacent write, same as writeOkfManifest above.
        // Ownership means "what Myco last WROTE", never "what's on disk": a page
        // this run staged is re-fingerprinted from its new content, but a page
        // carried forward untouched keeps its PRIOR fingerprint verbatim, and a
        // page Myco never owned is never adopted. Re-fingerprinting the whole
        // swapped-in tree (the old behavior) would fingerprint a human's
        // between-runs hand-edit of an untouched page as Myco's own output —
        // `isHandEdited` would then read false and a later synthesis could
        // silently clobber the edit. A crash between the atomic swap and this
        // write is healed by reconcileOwnershipForRoot on the next session open.
        this.deps.vault.writeOkfOwnership(
          this.computeOwnershipCarryingForward(
            outputRoot,
            stagedPaths,
            this.deps.vault.readOkfOwnership(),
            nextGeneration,
            generatedAt,
          ),
        );
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
  // Staged-tree materialization
  // -------------------------------------------------------------------

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
    // Recovery obeys the same "ownership = what Myco last WROTE" rule as
    // finalize. A crash in the window between the atomic swap (marker → gen N)
    // and the ownership write leaves ownership.json stamped at a stale
    // generation; recomputing EVERY fingerprint from disk (the old behavior)
    // would fingerprint a page a human hand-edited in that window as Myco's own
    // → isHandEdited goes false → a later run clobbers the edit. Instead CARRY
    // every prior fingerprint verbatim (a page Myco rewrote in the crashed run
    // keeps its old fingerprint too → the next run augments-not-clobbers, still
    // safe), and fingerprint fresh ONLY a page with no prior entry — the
    // cold-start baseline (a bundle published before ownership tracking, or a
    // net-new page from the crashed run; that net-new-in-crash-window edge is
    // the one residual, noted as a narrow follow-up).
    this.deps.vault.writeOkfOwnership(
      this.computeOwnershipCarryingForward(outputRoot, new Set(), existing, markerGen, generatedAt, {
        fingerprintUnowned: true,
      }),
    );
    warnings.push({
      code: 'crash_recovery',
      message: `ownership fingerprints reconciled to bundle generation ${markerGen} after an interrupted publish.`,
    });
  }

  /**
   * Compute the ownership manifest for a just-published tree WITHOUT adopting
   * anything Myco didn't write. Ownership must mean "what Myco last wrote", not
   * "what's on disk" — so, per content page currently under `outputRoot`:
   *   - staged THIS run (`stagedPaths`) → re-fingerprint from current content
   *     (Myco authored it this run);
   *   - untouched but already Myco-owned (in `priorOwnership`) → carry the prior
   *     fingerprint VERBATIM, so a human hand-edit made between runs still reads
   *     as hand-edited (`isHandEdited` true) and refine-not-clobber protects it;
   *   - neither staged nor previously owned → SKIP (human-authored; never
   *     adopted into Myco ownership via carry-forward).
   * Used by every finalize and crash-recovery call site — ownership is never
   * fingerprinted from the whole tree at once.
   *
   * `opts.fingerprintUnowned` flips the treatment of a page that is neither
   * staged nor in prior ownership: the default (false) SKIPs it (finalize/
   * mutateConcepts — a human-authored page is never adopted); recovery
   * (`reconcileOwnershipForRoot`) sets it true so a page with no prior
   * fingerprint is adopted from disk — the cold-start / net-new-page baseline.
   */
  private computeOwnershipCarryingForward(
    outputRoot: string,
    stagedPaths: Set<string>,
    priorOwnership: OkfOwnership | null,
    bundleGeneration: number,
    generatedAt: string,
    opts?: { fingerprintUnowned?: boolean },
  ): OkfOwnership {
    const fingerprintUnowned = opts?.fingerprintUnowned ?? false;
    const prior = priorOwnership?.pages ?? {};
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
        if (prior[rel] && !stagedPaths.has(rel)) {
          // Untouched, already Myco-owned → carry the prior fingerprint VERBATIM
          // (preserves isHandEdited for a between-runs hand-edit).
          pages[rel] = prior[rel];
        } else if (stagedPaths.has(rel) || fingerprintUnowned) {
          // Staged this run (Myco wrote it) OR recovery adopting a page with no
          // prior fingerprint → fingerprint from current content.
          try {
            pages[rel] = { fingerprint: sha256Hex(fs.readFileSync(abs, 'utf8')), generatedAt };
          } catch {
            /* skip unreadable */
          }
        }
        // else: not staged, not owned, not adopting → human-authored, never adopted.
      }
    };
    walk('');
    return { bundleGeneration, pages };
  }

  /**
   * Per-file-validate each carried page (a page NOT re-staged this run) with the
   * SAME strict rule set the whole-tree validate uses, and quarantine any that
   * fail: delete it from the staging dir and drop it from `carried` so it's
   * absent from the regenerated indexes, the publish-eligibility scan, the
   * strict validate, and the atomic-replace. One human-broken carried page then
   * can't wedge every future publish — the fresh pages still ship. Mutates
   * `carried` and `warnings` in place.
   */
  private quarantineInvalidCarriedPages(
    stagingDir: string,
    carriedPaths: Set<string>,
    stagedPaths: Set<string>,
    carried: Map<string, OkfDocument>,
    _mode: OkfBundleMode,
    warnings: OkfMaintainWarning[],
  ): void {
    for (const rel of carriedPaths) {
      if (stagedPaths.has(rel)) continue; // re-synthesized fresh this run — fresh content is validated wholesale below
      const abs = path.join(stagingDir, rel);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // already gone — nothing to quarantine
      }
      if (validateOkfDocumentFile(rel, raw, 'strict').ok) continue;
      this.safeUnlinkFile(abs);
      carried.delete(rel);
      warnings.push({
        code: 'carried_page_quarantined',
        message: 'a carried page failed OKF validation and was excluded from this publish; recover it from git history or the transient .myco/okf/state/backup-<gen> copy, then re-plan the page for a later run to republish it.',
        path: rel,
      });
    }
  }

  /**
   * Persist the findings that BLOCKED a synthesis publish to the manifest,
   * WITHOUT publishing the staged tree. Called on the block path in `finalize`
   * before it throws, so the block — which otherwise vanishes with the ephemeral
   * staged tree — is durable and surfaceable (status.pendingFindings) and
   * drainable ({@link acknowledgePendingFindings}). Runs under the finalize
   * lock, like every other manifest write here.
   */
  private persistPendingFindings(
    manifest: OkfPrivateManifest | null,
    findings: ReturnType<typeof scanStagedBundle>,
    outputRoot: string,
  ): void {
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
    this.deps.vault.writeOkfManifest({
      ...base,
      output_root: base.output_root || outputRoot,
      last_result: 'publish_blocked',
      pending_findings: findings.map((f) => ({ code: f.code, path: f.path, hash: f.hash })),
    });
  }

  /**
   * Acknowledge every finding currently pending a publish block: merge
   * `manifest.pending_findings` into `manifest.acknowledged_findings` (reusing
   * the same (code, path, hash) dedup as {@link mergeAcknowledgements}) and clear
   * `pending_findings`. The non-`maintain` acknowledge path (`POST
   * /api/okf/acknowledge`): the next synthesis run then sees `unacked.length ===
   * 0` and publishes. Lock-guarded like every other manifest write. Returns the
   * refreshed status (pending now empty).
   */
  async acknowledgePendingFindings(): Promise<OkfBundleStatus> {
    if (!capabilityEnabled(this.deps.config, 'okf')) {
      throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
    }
    const lock = await this.acquireLock();
    try {
      const manifest = this.deps.vault.readOkfManifest();
      const pending = manifest?.pending_findings ?? [];
      if (manifest && pending.length > 0) {
        const merged = [...manifest.acknowledged_findings];
        for (const f of pending) {
          if (!merged.some((a) => a.code === f.code && a.path === f.path && a.hash === f.hash)) {
            merged.push({ code: f.code, path: f.path, hash: f.hash });
          }
        }
        this.deps.vault.writeOkfManifest({ ...manifest, acknowledged_findings: merged, pending_findings: [] });
      }
      return this.status();
    } finally {
      this.releaseLock(lock);
    }
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
      pageCount: stats?.pageCount ?? null,
      publishAcknowledged: this.derivePublishAcknowledged(manifest, outputRoot),
      pendingFindings: manifest?.pending_findings ?? [],
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

  /**
   * List published OKF v0.1 document pages — every non-reserved `.md` in the
   * published tree (excluding `index.md`/`log.md`), each with its
   * bundle-relative path and OKF frontmatter `type`/`title`. The document-model
   * read primitive for the synthesis harness (`okf_list_pages`); it walks the
   * whole tree, not just `concepts/`, because synthesis documents live at
   * arbitrary bundle-relative paths.
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
   * through to `null` — an unsafe, unreadable, or unparseable path is always
   * reported as "not found" so no file outside the bundle is ever disclosed.
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
        throw new OkfError('okf_maintain_failed', 'no published OKF bundle to edit yet; it is created by the okf-synthesize task');
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
          // A concept edit only reaches here with no unacknowledged finding
          // (the block above threw otherwise) — clear any prior pending block.
          pending_findings: [],
          probe_fingerprint: manifest?.probe_fingerprint ?? null,
          last_run_ref: manifest?.last_run_ref ?? null,
        });
        // Ownership carries forward here too, and for the same reason as the
        // synthesis finalize path: this concept edit republishes the WHOLE
        // reconstructed tree — including any human-authored or hand-edited page
        // `reconstructConceptSet` picked up — so re-fingerprinting the whole tree
        // would silently adopt a non-Myco page (and mask a hand-edit) into
        // ownership. Re-fingerprint ONLY the concepts this edit actually changed;
        // untouched Myco pages keep their prior fingerprint, human pages stay
        // unowned. Byte-stable reconstruct means the "changed" set is normally
        // just the one edited concept.
        this.deps.vault.writeOkfOwnership(
          this.computeOwnershipCarryingForward(
            outputRoot,
            this.changedConceptPaths(existing, concepts),
            this.deps.vault.readOkfOwnership(),
            nextGeneration,
            generatedAt,
          ),
        );
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

  /**
   * The bundle-relative paths whose rendered content a concept mutation actually
   * changed (or newly added) — the "staged this run" set for
   * {@link computeOwnershipCarryingForward}. Compares the reconstructed
   * pre-mutation set against the post-mutation set by rendered bytes, so a
   * byte-stable untouched concept is NOT flagged (its ownership carries forward)
   * while the edited/added concept IS (Myco just wrote it). Rendered content is
   * exactly what ownership fingerprints, so this comparison and the fingerprint
   * can never disagree on "did Myco rewrite this page".
   */
  private changedConceptPaths(before: OkfConcept[], after: OkfConcept[]): Set<string> {
    const beforeByPath = new Map(before.map((c) => [conceptPathForId(c.id), renderConcept(c).content]));
    const changed = new Set<string>();
    for (const c of after) {
      const rel = conceptPathForId(c.id);
      const prev = beforeByPath.get(rel);
      if (prev === undefined || prev !== renderConcept(c).content) changed.add(rel);
    }
    return changed;
  }

  // -------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------

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
  private seedStagingFromPublished(
    stagingDir: string,
    outputRoot: string,
    carried: Map<string, OkfDocument>,
    carriedPaths: Set<string>,
  ): void {
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
        // Record EVERY carried page (parseable or not) so finalize's quarantine
        // pass per-file-validates each — an unparseable page is on disk but
        // absent from `carried`, and would otherwise sink the whole-tree strict
        // validate unnoticed.
        carriedPaths.add(rel);
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

  /**
   * Best-effort removal of a SINGLE staged file (content-level, not the
   * structural atomic-replace), using raw `fs` rather than the injectable
   * `fsOps` — matching seedStagingFromPublished/writeStagedDoc, which also stage
   * content with raw fs (only backup/swap ops route through `fsOps`).
   */
  private safeUnlinkFile(target: string): void {
    try {
      fs.rmSync(target, { force: true });
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
