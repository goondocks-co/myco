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
 * Release is a transactional rollback: in addition to restoring the
 * claimed Grove's DB, it undoes any Grove-registry side effects that
 * landed during the claim window (new Groves created, projects moved
 * between Groves, project vault manifest edits, default-Grove pointer
 * changes). Other Groves' DBs are NOT snapshotted in this version — if
 * a move during the claim window wrote rows into a different Grove's
 * DB, deleting that Grove (when it was created during the claim) wipes
 * the rows; if the destination Grove pre-existed, the rows remain.
 * Document this caveat clearly to callers.
 *
 * Phases (recorded on a manifest file under
 * `<claimRoot>/claim.json` so a crash is recoverable on the next call):
 *
 *   claim:    pause -> file-copy snapshot + registry snapshot
 *               + project-manifest snapshot -> manifest written
 *               (phase=claimed) -> served_by flipped (phase=flipped)
 *               -> resume (done)
 *   release:  pause -> file-copy restore -> registry-restored
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
  resolveGrovesDir,
  resolveProjectVaultDir,
  resolveProjectManifestPath,
  resolveProjectLocalManifestPath,
  resolveMycoHome,
} from './paths.js';
import {
  type DaemonVariant,
  type GroveRecord,
  clearGroveRegistryCaches,
  deleteGrove,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  pauseProject,
  resumeProject,
  setGroveServedBy,
} from './registry.js';

export type ClaimPhase = 'claimed' | 'flipped';
export type ReleasePhase = 'restored' | 'registry-restored' | 'flipped' | 'archived';

export interface ClaimManifest {
  schema: 3;
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
  /**
   * Directory containing a recursive copy of the `~/.myco/groves/`
   * registry tree at claim time (every Grove's `grove.toml`,
   * `grove.yaml`, `registry/projects.toml`, `registry/roots.toml`,
   * plus the cross-Grove `registry.yaml`). DB files are excluded — only
   * the claimed Grove's DB is snapshotted (top-level `snapshot_db_path`).
   */
  snapshot_registry_dir: string;
  /**
   * Directory containing per-project copies of `<root>/.myco/project.toml`
   * and `<root>/.myco/project.local.toml` for every project registered in
   * any Grove at claim time. Layout: `<dir>/<project_id>/project.toml`
   * and `<dir>/<project_id>/project.local.toml` (each optional).
   */
  snapshot_project_manifests_dir: string;
  claim_root: string;
  claimed_at: number;
  owner_op: string;
  /**
   * Phase tracking. `claimed` is set the moment the snapshot is on disk
   * but before served_by has been flipped. `flipped` records the flip.
   * Release advances the same manifest through `restored`,
   * `registry-restored`, `flipped`, `archived`.
   */
  phase: ClaimPhase | ReleasePhase;
  release_owner_op?: string;
}

export interface ClaimResult {
  grove: GroveRecord;
  manifest: ClaimManifest;
  manifest_path: string;
  /** One-line human-readable summary of bytes held by the snapshot tree. */
  snapshot_size_summary: string;
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
const SNAPSHOT_REGISTRY_DIRNAME = 'registry-snapshot';
const SNAPSHOT_PROJECT_MANIFESTS_DIRNAME = 'project-manifests';
const PROJECT_MANIFEST_FILENAME = 'project.toml';
const PROJECT_LOCAL_MANIFEST_FILENAME = 'project.local.toml';
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
    if (parsed.schema === 2) {
      throw new Error(
        `Legacy claim manifest (schema=2) at ${manifestPath}: this file `
        + `predates the transactional release flow (no registry snapshot). `
        + `Use \`myco grove set-served-by <slug> --force\` to reset served_by `
        + `and then restore the Grove DB by hand from the snapshot at `
        + `${(parsed as { snapshot_db_path?: string }).snapshot_db_path ?? '<unknown>'}.`,
      );
    }
    if (
      parsed.schema === 3
      && typeof parsed.grove_id === 'string'
      && typeof parsed.grove_slug === 'string'
      && typeof parsed.grove_name === 'string'
      && (parsed.original_served_by === 'service' || parsed.original_served_by === 'service-dev')
      && typeof parsed.snapshot_db_path === 'string'
      && typeof parsed.snapshot_registry_dir === 'string'
      && typeof parsed.snapshot_project_manifests_dir === 'string'
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

/**
 * Copy registry files (TOML/YAML metadata) under a Grove tree. DB files
 * are excluded — they're snapshotted separately by their own path
 * resolvers, or (for non-claimed Groves) intentionally not snapshotted
 * in this version.
 */
function isRegistryFile(name: string): boolean {
  // .toml and .yaml only; this excludes myco.db, vectors.db, *-shm,
  // *-wal, *.sql, backups/.
  return name.endsWith('.toml') || name.endsWith('.yaml');
}

function copyRegistryTree(sourceDir: string, destDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      copyRegistryTree(source, dest);
    } else if (entry.isFile() && isRegistryFile(entry.name)) {
      fs.copyFileSync(source, dest);
    }
  }
}

function snapshotProjectManifests(
  destDir: string,
  mycoHome: string,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const grove of listGroves(mycoHome)) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      const vaultDir = resolveProjectVaultDir(project.root);
      const projectDest = path.join(destDir, project.project_id);
      const manifestSrc = resolveProjectManifestPath(vaultDir);
      const localSrc = resolveProjectLocalManifestPath(vaultDir);
      let copied = false;
      if (fs.existsSync(manifestSrc)) {
        fs.mkdirSync(projectDest, { recursive: true });
        fs.copyFileSync(manifestSrc, path.join(projectDest, PROJECT_MANIFEST_FILENAME));
        copied = true;
      }
      if (fs.existsSync(localSrc)) {
        if (!copied) fs.mkdirSync(projectDest, { recursive: true });
        fs.copyFileSync(localSrc, path.join(projectDest, PROJECT_LOCAL_MANIFEST_FILENAME));
      }
    }
  }
}

/**
 * Recursive directory-size walk. Best-effort: unreadable entries count
 * as zero.
 */
function dirSize(target: string): number {
  let total = 0;
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    try {
      total += dirSize(path.join(target, entry.name));
    } catch {
      // Skip unreadable entries.
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)}GB`;
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
        snapshot_size_summary: summarizeSnapshotSize(existing.manifest),
      };
    }
    if (existing.manifest.phase === 'claimed') {
      return resumeClaimFromManifest(grove, existing, mycoHome);
    }
    if (
      existing.manifest.phase === 'restored'
      || existing.manifest.phase === 'registry-restored'
      || existing.manifest.phase === 'archived'
    ) {
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
  const snapshotRegistryDir = path.join(claimRoot, SNAPSHOT_REGISTRY_DIRNAME);
  const snapshotProjectManifestsDir = path.join(claimRoot, SNAPSHOT_PROJECT_MANIFESTS_DIRNAME);
  let vectorsSnapshotted = false;

  try {
    snapshotSqliteFile(dbPath, snapshotDbPath);
    if (fs.existsSync(vectorsPath)) {
      snapshotSqliteFile(vectorsPath, snapshotVectorsPath);
      vectorsSnapshotted = true;
    }
    copyRegistryTree(resolveGrovesDir(mycoHome), snapshotRegistryDir);
    snapshotProjectManifests(snapshotProjectManifestsDir, mycoHome);
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
    schema: 3,
    grove_id: grove.id,
    grove_slug: grove.slug,
    grove_name: grove.name,
    original_served_by: grove.served_by,
    snapshot_db_path: snapshotDbPath,
    ...(vectorsSnapshotted ? { snapshot_vectors_path: snapshotVectorsPath } : {}),
    snapshot_registry_dir: snapshotRegistryDir,
    snapshot_project_manifests_dir: snapshotProjectManifestsDir,
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
  return {
    grove: refreshed,
    manifest,
    manifest_path: manifestPath,
    snapshot_size_summary: summarizeSnapshotSize(manifest),
  };
}

function summarizeSnapshotSize(manifest: ClaimManifest): string {
  const dbBytes = fs.existsSync(manifest.snapshot_db_path)
    ? fs.statSync(manifest.snapshot_db_path).size
    : 0;
  const vectorsBytes = manifest.snapshot_vectors_path && fs.existsSync(manifest.snapshot_vectors_path)
    ? fs.statSync(manifest.snapshot_vectors_path).size
    : 0;
  const registryBytes = dirSize(manifest.snapshot_registry_dir);
  const manifestsBytes = dirSize(manifest.snapshot_project_manifests_dir);
  const total = dbBytes + vectorsBytes + registryBytes + manifestsBytes;
  return (
    `Snapshot total size: ${formatBytes(total)} `
    + `(claimed Grove DB ${formatBytes(dbBytes)}, `
    + `vectors ${formatBytes(vectorsBytes)}, `
    + `registry ${formatBytes(registryBytes)}, `
    + `project manifests ${formatBytes(manifestsBytes)})`
  );
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
    return {
      grove: refreshed,
      manifest: next,
      manifest_path: state.manifestPath,
      snapshot_size_summary: summarizeSnapshotSize(next),
    };
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
 * Identify which Grove ID directories the registry snapshot held at
 * claim time. Each subdirectory of `snapshot_registry_dir` whose name
 * begins with `grove_` is a Grove. The cross-Grove `registry.yaml`
 * lives at the top level (not a Grove).
 */
function listSnapshotGroveIds(snapshotRegistryDir: string): string[] {
  if (!fs.existsSync(snapshotRegistryDir)) return [];
  return fs
    .readdirSync(snapshotRegistryDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('grove_'))
    .map((e) => e.name);
}

function listLiveGroveIds(mycoHome: string): string[] {
  const dir = resolveGrovesDir(mycoHome);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('grove_'))
    .map((e) => e.name);
}

/**
 * Copy registry files from `snapshotGroveDir` into `liveGroveDir`,
 * overwriting any registry files already there. DB files are not
 * touched. Used by release to restore a Grove's registry to its
 * pre-claim shape.
 */
function restoreGroveRegistryFiles(snapshotGroveDir: string, liveGroveDir: string): void {
  if (!fs.existsSync(snapshotGroveDir)) return;
  fs.mkdirSync(liveGroveDir, { recursive: true });
  for (const entry of fs.readdirSync(snapshotGroveDir, { withFileTypes: true })) {
    const src = path.join(snapshotGroveDir, entry.name);
    const dest = path.join(liveGroveDir, entry.name);
    if (entry.isDirectory()) {
      restoreGroveRegistryFiles(src, dest);
    } else if (entry.isFile() && isRegistryFile(entry.name)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Restore the cross-Grove `registry.yaml` (default_grove_id pointer).
 */
function restoreCrossGroveRegistry(snapshotRegistryDir: string, mycoHome: string): void {
  const src = path.join(snapshotRegistryDir, 'registry.yaml');
  if (!fs.existsSync(src)) return;
  const dest = path.join(resolveGrovesDir(mycoHome), 'registry.yaml');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Restore every snapshotted project's vault manifests. Skips any project
 * whose vault directory no longer exists (deleted during the claim
 * window — accept and warn rather than failing the release).
 */
function restoreProjectManifests(snapshotProjectManifestsDir: string, mycoHome: string): void {
  if (!fs.existsSync(snapshotProjectManifestsDir)) return;
  for (const entry of fs.readdirSync(snapshotProjectManifestsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    const projectSnapshotDir = path.join(snapshotProjectManifestsDir, projectId);
    // Look up the project's root via the snapshotted Grove registry —
    // that's where the project.root lived at claim time.
    const projectRoot = findProjectRootInSnapshot(
      path.join(path.dirname(snapshotProjectManifestsDir), SNAPSHOT_REGISTRY_DIRNAME),
      projectId,
    );
    if (!projectRoot) continue;
    const vaultDir = resolveProjectVaultDir(projectRoot);
    if (!fs.existsSync(vaultDir)) {
      // Vault gone (project moved on disk or deleted). Warn via stderr
      // so the user sees it but don't fail the release.
      process.stderr.write(
        `warn: project vault ${vaultDir} (id ${projectId}) missing; skipping manifest restore\n`,
      );
      continue;
    }
    const snapshotManifest = path.join(projectSnapshotDir, PROJECT_MANIFEST_FILENAME);
    const snapshotLocal = path.join(projectSnapshotDir, PROJECT_LOCAL_MANIFEST_FILENAME);
    if (fs.existsSync(snapshotManifest)) {
      fs.copyFileSync(snapshotManifest, resolveProjectManifestPath(vaultDir));
    }
    if (fs.existsSync(snapshotLocal)) {
      fs.copyFileSync(snapshotLocal, resolveProjectLocalManifestPath(vaultDir));
    }
    void mycoHome;
  }
}

/**
 * Scan the snapshot registry for the project's recorded `root`. Reads
 * each Grove's `registry/projects.toml` from the snapshot until the
 * project is found.
 */
function findProjectRootInSnapshot(
  snapshotRegistryDir: string,
  projectId: string,
): string | null {
  if (!fs.existsSync(snapshotRegistryDir)) return null;
  for (const entry of fs.readdirSync(snapshotRegistryDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('grove_')) continue;
    const projectsTomlPath = path.join(snapshotRegistryDir, entry.name, 'registry', 'projects.toml');
    if (!fs.existsSync(projectsTomlPath)) continue;
    const text = fs.readFileSync(projectsTomlPath, 'utf-8');
    // Lightweight TOML scan to avoid pulling the parser here. The
    // project block looks like:
    //   [projects.proj_xxx]
    //   ...
    //   root = "/abs/path"
    const lines = text.split('\n');
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inBlock = trimmed === `[projects.${projectId}]`;
        continue;
      }
      if (!inBlock) continue;
      const m = trimmed.match(/^root\s*=\s*"([^"]+)"$/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Release a previously claimed Grove. Restores the snapshot taken at
 * claim time, undoes Grove-registry side effects (new Groves deleted,
 * project moves reverted via registry + vault-manifest restore),
 * flips `served_by` back to the original, and archives the claim
 * directory.
 *
 * Idempotent on phase transitions:
 *   - `claimed`/`flipped`     → starts release; performs DB restore.
 *   - `restored`              → resumes from the registry-restore step.
 *   - `registry-restored`     → resumes from the flip step.
 *   - `flipped` (post-restore) → resumes from archive.
 *   - `archived`              → no-op.
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

  // Pause every project across every Grove for the restore window.
  // Registry-restore writes Grove projects.toml files; if a non-claimed
  // Grove's project were busy, a concurrent write to its registry could
  // race the restore.
  const pauseTargets: Array<{ groveId: string; projectId: string }> = [];
  const pausedProjects: Array<{ groveId: string; projectId: string }> = [];
  for (const liveGrove of listGroves(mycoHome)) {
    for (const project of listRegisteredProjects(liveGrove.id, mycoHome)) {
      pauseTargets.push({ groveId: liveGrove.id, projectId: project.project_id });
    }
  }

  try {
    for (const { groveId: gid, projectId: pid } of pauseTargets) {
      pauseProject(gid, pid, 'grove-release', releaseOwnerOp, mycoHome);
      pausedProjects.push({ groveId: gid, projectId: pid });
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
      restoreRegistryState(manifest, mycoHome);
      manifest = { ...manifest, phase: 'registry-restored' };
      writeManifestAtomic(open.manifestPath, manifest);
    }

    if (manifest.phase === 'registry-restored') {
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
    for (const { groveId: gid, projectId: pid } of pausedProjects) {
      try {
        resumeProject(gid, pid, releaseOwnerOp, mycoHome);
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Apply the registry-restore step: delete new Groves, restore kept
 * Groves' registry files, restore project vault manifests, restore the
 * cross-Grove default-Grove pointer.
 *
 * Limitation (pragmatic scope): for Groves that existed at claim time
 * and still exist now, only registry files are restored — the Grove's
 * DB is not. If the user moved a project from Default into Other-Grove
 * during the claim, restoring Default's DB brings the project's rows
 * back to Default, but the duplicate copy that the move wrote into
 * Other-Grove stays in Other-Grove's DB until that Grove is touched by
 * a later move or compaction. Document this clearly to callers.
 */
function restoreRegistryState(manifest: ClaimManifest, mycoHome: string): void {
  const snapshotGroveIds = new Set(listSnapshotGroveIds(manifest.snapshot_registry_dir));
  const liveGroveIds = new Set(listLiveGroveIds(mycoHome));

  // New Groves (live but not in snapshot) → delete with force=true so
  // any post-claim bound projects come off cleanly. The project
  // vault-manifest restore below repoints them back to their
  // snapshotted Grove.
  for (const liveId of liveGroveIds) {
    if (snapshotGroveIds.has(liveId)) continue;
    try {
      deleteGrove(liveId, { force: true }, mycoHome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warn: failed to delete new Grove ${liveId} on release: ${msg}\n`);
    }
  }

  // Snapshotted Groves that disappeared during the claim — restore
  // their registry files. DB is not restored (other-Grove-DB snapshots
  // are out of scope for this version); the user gets a warning so
  // they know to recover the DB manually if needed.
  for (const snapId of snapshotGroveIds) {
    if (liveGroveIds.has(snapId)) continue;
    const snapDir = path.join(manifest.snapshot_registry_dir, snapId);
    const liveDir = path.join(resolveGrovesDir(mycoHome), snapId);
    restoreGroveRegistryFiles(snapDir, liveDir);
    process.stderr.write(
      `warn: Grove ${snapId} was deleted during the claim window; restored its `
      + `registry files only — its DB cannot be restored by release (recover from `
      + `~/myco_backups if you need the data).\n`,
    );
  }

  // Kept Groves: restore registry files to undo any project moves.
  for (const groveId of snapshotGroveIds) {
    if (!liveGroveIds.has(groveId)) continue;
    const snapDir = path.join(manifest.snapshot_registry_dir, groveId);
    const liveDir = path.join(resolveGrovesDir(mycoHome), groveId);
    restoreGroveRegistryFiles(snapDir, liveDir);
  }

  // Cross-Grove registry (default_grove_id).
  restoreCrossGroveRegistry(manifest.snapshot_registry_dir, mycoHome);

  // Project vault manifests — repoints moved projects back to their
  // original Grove, undoes any rename/grove-pointer edits on disk.
  restoreProjectManifests(manifest.snapshot_project_manifests_dir, mycoHome);

  // Caches now stale (we wrote registry files directly, bypassing the
  // helpers that invalidate caches).
  clearGroveRegistryCaches();
}
