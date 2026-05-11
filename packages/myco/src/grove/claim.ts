/**
 * Grove dogfood claim/release — flip a Grove's `served_by` between the
 * production daemon (`service`) and the dev daemon (`service-dev`), with
 * a full-Grove file-copy snapshot taken at claim time and copied back on
 * release so the production state is restored after dogfooding.
 *
 * Snapshots are byte-for-byte copies of the Grove `myco.db` and
 * `vectors.db` files. SQLite's own file format is the format we trust:
 * file copy can't lose data the way the previous SQL-dump approach did
 * (multi-line text values were silently truncated by the line-based
 * restore parser).
 *
 * Phases (recorded on a manifest file under
 * `<claimRoot>/claim.json` so a crash is recoverable on the next call):
 *
 *   claim:    pause -> file-copy snapshot -> manifest written
 *               (phase=claimed) -> served_by flipped (phase=flipped)
 *               -> resume (done)
 *   release:  pause -> file-copy restore (phase=restored)
 *               -> served_by flipped (phase=flipped)
 *               -> archive (phase=archived) -> resume (done)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import {
  resolveGroveDbPath,
  resolveGroveVectorsPath,
  resolveMycoHome,
} from './paths.js';
import {
  type DaemonVariant,
  type GroveRecord,
  listRegisteredProjects,
  loadGroveRecord,
  pauseProject,
  resumeProject,
  setGroveServedBy,
} from './registry.js';

export type ClaimPhase = 'claimed' | 'flipped';
export type ReleasePhase = 'restored' | 'flipped' | 'archived';

export interface ClaimManifest {
  schema: 2;
  grove_id: string;
  grove_slug: string;
  grove_name: string;
  original_served_by: DaemonVariant;
  /** Absolute path to the byte-for-byte copy of the Grove `myco.db`. */
  snapshot_db_path: string;
  /**
   * Absolute path to the byte-for-byte copy of the Grove `vectors.db`.
   * Optional because some pre-WB Groves never created a vectors file —
   * if the source has no vectors.db, the snapshot just omits it.
   */
  snapshot_vectors_path?: string;
  claim_root: string;
  claimed_at: number;
  owner_op: string;
  /**
   * Phase tracking. `claimed` is set the moment the snapshot is on disk
   * but before served_by has been flipped. `flipped` records the flip.
   * Release advances the same manifest through `restored`, `flipped`,
   * `archived`.
   */
  phase: ClaimPhase | ReleasePhase;
  release_owner_op?: string;
}

export interface ClaimResult {
  grove: GroveRecord;
  manifest: ClaimManifest;
  manifest_path: string;
}

export interface ReleaseResult {
  grove: GroveRecord;
  manifest: ClaimManifest;
  manifest_path: string;
  archive_dir: string;
}

export interface ClaimOptions {
  /** Override the backup root. Defaults to MYCO_BACKUPS_DIR or `~/myco_backups`. */
  backupsRoot?: string;
}

const CLAIMS_DIRNAME = 'claims';
const ARCHIVE_DIRNAME = 'archive';
const MANIFEST_FILENAME = 'claim.json';
const SNAPSHOT_DB_FILENAME = 'grove-claim.db';
const SNAPSHOT_VECTORS_FILENAME = 'vectors-claim.db';
const ARCHIVE_RETENTION_DAYS = 30;

function resolveBackupRoot(override?: string): string {
  if (override) return path.resolve(override);
  const env = process.env.MYCO_BACKUPS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), 'myco_backups');
}

function claimsRoot(backupsRoot: string): string {
  return path.join(backupsRoot, CLAIMS_DIRNAME);
}

function groveClaimsDir(backupsRoot: string, groveSlug: string): string {
  return path.join(claimsRoot(backupsRoot), groveSlug);
}

function groveArchiveDir(backupsRoot: string, groveSlug: string): string {
  return path.join(groveClaimsDir(backupsRoot, groveSlug), ARCHIVE_DIRNAME);
}

function listActiveClaimDirs(backupsRoot: string, groveSlug: string): string[] {
  const dir = groveClaimsDir(backupsRoot, groveSlug);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ARCHIVE_DIRNAME) continue;
    const full = path.join(dir, entry.name);
    if (fs.existsSync(path.join(full, MANIFEST_FILENAME))) {
      out.push(full);
    }
  }
  // Most-recent first; directory names are epoch timestamps so a
  // lexicographic sort matches chronological order until year ~2286.
  return out.sort().reverse();
}

function writeManifestAtomic(manifestPath: string, manifest: ClaimManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmp, manifestPath);
}

function readManifest(manifestPath: string): ClaimManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Omit<ClaimManifest, 'schema'>> & {
      schema?: number;
      // Legacy schema-1 field, retained here only so we can detect and
      // reject it cleanly. Remove when no v1 manifests can plausibly
      // exist on disk anywhere.
      snapshot_path?: string;
    };
    if (parsed.schema === 1) {
      throw new Error(
        `Legacy claim manifest (schema=1) at ${manifestPath}: this file `
        + `was produced by an older claim/release flow whose SQL-dump snapshot `
        + `is no longer supported. Restore it manually with `
        + `\`myco grove set-served-by <slug> --force\` after recovering the `
        + `affected Grove DB from your routine backups.`,
      );
    }
    if (
      parsed.schema === 2
      && typeof parsed.grove_id === 'string'
      && typeof parsed.grove_slug === 'string'
      && typeof parsed.grove_name === 'string'
      && (parsed.original_served_by === 'service' || parsed.original_served_by === 'service-dev')
      && typeof parsed.snapshot_db_path === 'string'
      && typeof parsed.claim_root === 'string'
      && typeof parsed.claimed_at === 'number'
      && typeof parsed.owner_op === 'string'
      && typeof parsed.phase === 'string'
    ) {
      return parsed as ClaimManifest;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Legacy claim manifest')) {
      throw err;
    }
    return null;
  }
  return null;
}

/**
 * Flush WAL into the main DB file and copy it byte-for-byte. The copy
 * is the snapshot; SQLite's own file format is the format we trust.
 *
 * SQL-dump snapshots (the previous design) lost data on any row whose
 * text payload spanned multiple lines, because the restore parser was
 * line-based. File copy can't lose data — every byte that was in the
 * source file ends up in the snapshot.
 */
function snapshotSqliteFile(sourcePath: string, destPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source SQLite file does not exist: ${sourcePath}`);
  }
  // Checkpoint the WAL so the main file is up-to-date, then copy it.
  // Best-effort: a non-SQLite file (test fixture) or a DB without a WAL
  // sidecar just skips this step — the file copy below is the actual
  // snapshot contract.
  try {
    const db = openDatabase(sourcePath);
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {
    // Not a SQLite DB, or unable to open. Fall through to plain copy.
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
}

/**
 * Replace a live SQLite file with the snapshot. The caller must ensure
 * no DB connections are open against `destPath` at the moment of copy —
 * the daemon is paused (projects paused; daemon variant flipped) so
 * the only writer is the dev daemon, which is what's flipping.
 *
 * Also removes any leftover `-wal` / `-shm` sidecars so a stale journal
 * can't reattach to the freshly copied main file.
 */
function restoreSqliteFile(snapshotPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(snapshotPath, destPath);
  for (const sidecar of [`${destPath}-wal`, `${destPath}-shm`]) {
    try {
      fs.unlinkSync(sidecar);
    } catch {
      // Sidecar may not exist; that's fine.
    }
  }
}

interface OpenClaimState {
  manifestPath: string;
  manifest: ClaimManifest;
  claimRoot: string;
  others: string[];
}

function findOpenClaim(backupsRoot: string, groveSlug: string): OpenClaimState | null {
  const dirs = listActiveClaimDirs(backupsRoot, groveSlug);
  if (dirs.length === 0) return null;
  const [head, ...rest] = dirs;
  const manifestPath = path.join(head, MANIFEST_FILENAME);
  const manifest = readManifest(manifestPath);
  if (!manifest) return null;
  return { manifestPath, manifest, claimRoot: head, others: rest };
}

function pruneArchivesOlderThan(
  archiveRoot: string,
  cutoffMs: number,
): void {
  if (!fs.existsSync(archiveRoot)) return;
  for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(archiveRoot, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoffMs) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

/**
 * Claim a Grove for dogfooding. Returns the manifest record and its path
 * on disk. Idempotent: re-running with an existing manifest in `claimed`
 * phase resumes from after the snapshot; in `flipped` phase, it is a
 * no-op and returns the existing state.
 */
export function claimGroveForDogfood(
  groveId: string,
  mycoHome: string = resolveMycoHome(),
  options: ClaimOptions = {},
): ClaimResult {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);
  if (grove.served_by !== 'service' && grove.served_by !== 'service-dev') {
    throw new Error(`Grove ${grove.slug} has unrecognized served_by: ${grove.served_by}`);
  }

  const backupsRoot = resolveBackupRoot(options.backupsRoot);
  const existing = findOpenClaim(backupsRoot, grove.slug);

  if (existing) {
    if (existing.manifest.grove_id !== grove.id) {
      throw new Error(
        `An open claim manifest exists for slug ${grove.slug} but its grove_id `
        + `(${existing.manifest.grove_id}) does not match the resolved Grove (${grove.id})`,
      );
    }
    if (existing.manifest.phase === 'flipped') {
      return {
        grove,
        manifest: existing.manifest,
        manifest_path: existing.manifestPath,
      };
    }
    if (existing.manifest.phase === 'claimed') {
      return resumeClaimFromManifest(grove, existing, mycoHome);
    }
    if (existing.manifest.phase === 'restored' || existing.manifest.phase === 'archived') {
      throw new Error(
        `A release is mid-flight for Grove ${grove.slug} (phase=${existing.manifest.phase}). `
        + `Run \`myco grove release ${grove.slug}\` to finish it before re-claiming.`,
      );
    }
    throw new Error(`Unexpected claim phase: ${existing.manifest.phase}`);
  }

  if (grove.served_by !== 'service') {
    throw new Error(
      `Grove ${grove.slug} is already served by ${grove.served_by}; only Groves `
      + `served by 'service' can be claimed for dogfood.`,
    );
  }

  const ts = epochSeconds();
  const claimRoot = path.join(groveClaimsDir(backupsRoot, grove.slug), String(ts));
  const manifestPath = path.join(claimRoot, MANIFEST_FILENAME);
  const ownerOp = `grove-claim-${grove.slug}-${ts}`;

  fs.mkdirSync(claimRoot, { recursive: true });

  const projects = listRegisteredProjects(grove.id, mycoHome);
  const pausedProjectIds: string[] = [];
  try {
    for (const project of projects) {
      pauseProject(grove.id, project.project_id, 'grove-claim', ownerOp, mycoHome);
      pausedProjectIds.push(project.project_id);
    }
  } catch (err) {
    for (const id of pausedProjectIds) {
      try {
        resumeProject(grove.id, id, ownerOp, mycoHome);
      } catch {
        // Best-effort cleanup; surface the original error below.
      }
    }
    fs.rmSync(claimRoot, { recursive: true, force: true });
    throw err;
  }

  const dbPath = resolveGroveDbPath(grove.id, mycoHome);
  const vectorsPath = resolveGroveVectorsPath(grove.id, mycoHome);
  const snapshotDbPath = path.join(claimRoot, SNAPSHOT_DB_FILENAME);
  const snapshotVectorsPath = path.join(claimRoot, SNAPSHOT_VECTORS_FILENAME);
  let vectorsSnapshotted = false;

  try {
    snapshotSqliteFile(dbPath, snapshotDbPath);
    if (fs.existsSync(vectorsPath)) {
      snapshotSqliteFile(vectorsPath, snapshotVectorsPath);
      vectorsSnapshotted = true;
    }
  } catch (err) {
    for (const id of pausedProjectIds) {
      try {
        resumeProject(grove.id, id, ownerOp, mycoHome);
      } catch {
        // Best-effort.
      }
    }
    fs.rmSync(claimRoot, { recursive: true, force: true });
    throw err;
  }

  let manifest: ClaimManifest = {
    schema: 2,
    grove_id: grove.id,
    grove_slug: grove.slug,
    grove_name: grove.name,
    original_served_by: grove.served_by,
    snapshot_db_path: snapshotDbPath,
    ...(vectorsSnapshotted ? { snapshot_vectors_path: snapshotVectorsPath } : {}),
    claim_root: claimRoot,
    claimed_at: ts,
    owner_op: ownerOp,
    phase: 'claimed',
  };
  writeManifestAtomic(manifestPath, manifest);

  setGroveServedBy(grove.id, 'service-dev', mycoHome);
  manifest = { ...manifest, phase: 'flipped' };
  writeManifestAtomic(manifestPath, manifest);

  for (const id of pausedProjectIds) {
    try {
      resumeProject(grove.id, id, ownerOp, mycoHome);
    } catch {
      // A pause we just took ourselves should always be resumable;
      // swallow only to keep the claim from rolling back on a benign
      // already-resumed condition.
    }
  }

  const refreshed = loadGroveRecord(grove.id, mycoHome) ?? grove;
  return { grove: refreshed, manifest, manifest_path: manifestPath };
}

function resumeClaimFromManifest(
  grove: GroveRecord,
  state: OpenClaimState,
  mycoHome: string,
): ClaimResult {
  const projects = listRegisteredProjects(grove.id, mycoHome);
  for (const project of projects) {
    pauseProject(grove.id, project.project_id, 'grove-claim', state.manifest.owner_op, mycoHome);
  }
  try {
    setGroveServedBy(grove.id, 'service-dev', mycoHome);
    const next: ClaimManifest = { ...state.manifest, phase: 'flipped' };
    writeManifestAtomic(state.manifestPath, next);
    const refreshed = loadGroveRecord(grove.id, mycoHome) ?? grove;
    return { grove: refreshed, manifest: next, manifest_path: state.manifestPath };
  } finally {
    for (const project of projects) {
      try {
        resumeProject(grove.id, project.project_id, state.manifest.owner_op, mycoHome);
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Release a previously claimed Grove. Restores the snapshot taken at
 * claim time, flips `served_by` back to the original, and archives the
 * claim directory.
 *
 * Idempotent on phase transitions:
 *   - `claimed`/`flipped` → starts release; performs purge + restore.
 *   - `restored` → resumes from the flip step.
 *   - `archived` → no-op.
 */
export function releaseClaimedGrove(
  groveId: string,
  mycoHome: string = resolveMycoHome(),
  options: ClaimOptions = {},
): ReleaseResult {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const backupsRoot = resolveBackupRoot(options.backupsRoot);
  const open = findOpenClaim(backupsRoot, grove.slug);
  if (!open) {
    throw new Error(
      `No active claim manifest found for Grove ${grove.slug} at `
      + `${groveClaimsDir(backupsRoot, grove.slug)}. Nothing to release.`,
    );
  }
  if (open.manifest.grove_id !== grove.id) {
    throw new Error(
      `Claim manifest at ${open.manifestPath} is for grove_id ${open.manifest.grove_id}, `
      + `but the resolved Grove is ${grove.id}`,
    );
  }
  if (!fs.existsSync(open.manifest.snapshot_db_path)) {
    throw new Error(
      `Claim snapshot is missing at ${open.manifest.snapshot_db_path}; cannot restore. `
      + `Use \`myco grove set-served-by --force\` to reset served_by manually.`,
    );
  }

  const releaseOwnerOp = open.manifest.release_owner_op
    ?? `grove-release-${grove.slug}-${epochSeconds()}`;
  let manifest: ClaimManifest = open.manifest.release_owner_op
    ? open.manifest
    : { ...open.manifest, release_owner_op: releaseOwnerOp };
  if (manifest !== open.manifest) writeManifestAtomic(open.manifestPath, manifest);

  const projects = listRegisteredProjects(grove.id, mycoHome);
  const pausedProjectIds: string[] = [];
  try {
    for (const project of projects) {
      pauseProject(grove.id, project.project_id, 'grove-release', releaseOwnerOp, mycoHome);
      pausedProjectIds.push(project.project_id);
    }

    const dbPath = resolveGroveDbPath(grove.id, mycoHome);
    const vectorsPath = resolveGroveVectorsPath(grove.id, mycoHome);

    if (manifest.phase === 'claimed' || manifest.phase === 'flipped') {
      restoreSqliteFile(manifest.snapshot_db_path, dbPath);
      if (manifest.snapshot_vectors_path && fs.existsSync(manifest.snapshot_vectors_path)) {
        restoreSqliteFile(manifest.snapshot_vectors_path, vectorsPath);
      }
      manifest = { ...manifest, phase: 'restored' };
      writeManifestAtomic(open.manifestPath, manifest);
    }

    if (manifest.phase === 'restored') {
      setGroveServedBy(grove.id, manifest.original_served_by, mycoHome);
      manifest = { ...manifest, phase: 'flipped' };
      writeManifestAtomic(open.manifestPath, manifest);
    }

    if (manifest.phase !== 'archived') {
      const archiveRoot = groveArchiveDir(backupsRoot, grove.slug);
      fs.mkdirSync(archiveRoot, { recursive: true });
      const archiveTarget = path.join(archiveRoot, path.basename(open.claimRoot));
      manifest = { ...manifest, phase: 'archived' };
      writeManifestAtomic(open.manifestPath, manifest);
      try {
        fs.renameSync(open.claimRoot, archiveTarget);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          fs.rmSync(open.claimRoot, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      const cutoffMs = Date.now() - ARCHIVE_RETENTION_DAYS * 86_400_000;
      pruneArchivesOlderThan(archiveRoot, cutoffMs);

      const refreshed = loadGroveRecord(grove.id, mycoHome) ?? grove;
      return {
        grove: refreshed,
        manifest,
        manifest_path: path.join(archiveTarget, MANIFEST_FILENAME),
        archive_dir: archiveTarget,
      };
    }

    const refreshed = loadGroveRecord(grove.id, mycoHome) ?? grove;
    return {
      grove: refreshed,
      manifest,
      manifest_path: open.manifestPath,
      archive_dir: open.claimRoot,
    };
  } finally {
    for (const id of pausedProjectIds) {
      try {
        resumeProject(grove.id, id, releaseOwnerOp, mycoHome);
      } catch {
        // Best-effort.
      }
    }
  }
}

