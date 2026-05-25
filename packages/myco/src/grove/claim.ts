/**
 * Grove dogfood claim/release — flip a Grove's `served_by` between the
 * production daemon (`service`) and the dev daemon (`service-dev`), with
 * a byte-for-byte snapshot of the Grove DBs at claim time and copied
 * back on release so production state is restored after dogfooding.
 *
 * Release is a transactional rollback: in addition to restoring the
 * claimed Grove's DB, it undoes any Grove-registry side effects that
 * landed during the claim window (new Groves, project moves between
 * Groves, project vault manifest edits, default-Grove pointer changes).
 * Other Groves' DBs are NOT snapshotted in this version — if a move
 * during the claim window wrote rows into a different Grove's DB,
 * deleting that Grove (when it was created during the claim) wipes the
 * rows; if the destination Grove pre-existed, the rows remain.
 *
 * State machine, recorded on `<claimRoot>/claim.json`:
 *
 *   claim_phase: 'claimed' → 'flipped'
 *     'claimed'  — snapshot on disk, served_by not yet flipped
 *     'flipped'  — served_by flipped to service-dev
 *
 *   release_phase: undefined → 'restored' → 'registry-restored'
 *                    → 'flipped' → 'archived'
 *     undefined            — release not started
 *     'restored'           — DB snapshot copied back into place
 *     'registry-restored'  — registry-side effects undone
 *     'flipped'            — served_by flipped back to service
 *     'archived'           — claim directory moved to archive
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import {
  resolveBackupsRoot,
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
import { readMarkerJson } from './marker.js';
import { parseProjectManifest, ProjectLocalManifestSchema } from '@myco/config/project-manifest.js';
import { parse } from 'smol-toml';
import { ProjectVault } from '@myco/vault/project-vault.js';

export type ClaimPhase = 'claimed' | 'flipped';
export type ReleasePhase = 'restored' | 'registry-restored' | 'flipped' | 'archived';

export const CLAIM_MANIFEST_SCHEMA = 4;

export interface ClaimManifest {
  schema: typeof CLAIM_MANIFEST_SCHEMA;
  grove_id: string;
  grove_slug: string;
  grove_name: string;
  original_served_by: DaemonVariant;
  /** Absolute path to the byte-for-byte copy of the Grove `myco.db`. */
  snapshot_db_path: string;
  /**
   * Absolute path to the byte-for-byte copy of the Grove `vectors.db`.
   * Omitted when the source has no vectors.db at claim time.
   */
  snapshot_vectors_path?: string;
  /**
   * Directory containing a recursive copy of the `~/.myco/groves/`
   * registry tree (every Grove's TOML/YAML metadata, plus the
   * cross-Grove `registry.yaml`). DB files are excluded.
   */
  snapshot_registry_dir: string;
  /**
   * Directory containing per-project copies of `<root>/.myco/project.toml`
   * and `<root>/.myco/project.local.toml` for every project registered
   * at claim time. Layout: `<dir>/<project_id>/project.toml`.
   */
  snapshot_project_manifests_dir: string;
  claim_root: string;
  claimed_at: number;
  owner_op: string;
  /** Claim state: 'claimed' = snapshot on disk; 'flipped' = served_by flipped. */
  claim_phase: ClaimPhase;
  /** Release state. Absent when release has not started. */
  release_phase?: ReleasePhase;
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
  // Directory names are epoch timestamps — lexicographic sort matches
  // chronological order until year ~2286.
  return out.sort().reverse();
}

function writeManifest(manifestPath: string, manifest: ClaimManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function validateManifest(raw: unknown): ClaimManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Record<string, unknown>;
  if (parsed.schema !== CLAIM_MANIFEST_SCHEMA) {
    throw new Error(
      `Unsupported claim manifest schema: ${String(parsed.schema)}. `
      + `Expected schema=${CLAIM_MANIFEST_SCHEMA}.`,
    );
  }
  if (
    typeof parsed.grove_id !== 'string'
    || typeof parsed.grove_slug !== 'string'
    || typeof parsed.grove_name !== 'string'
    || (parsed.original_served_by !== 'service' && parsed.original_served_by !== 'service-dev')
    || typeof parsed.snapshot_db_path !== 'string'
    || typeof parsed.snapshot_registry_dir !== 'string'
    || typeof parsed.snapshot_project_manifests_dir !== 'string'
    || typeof parsed.claim_root !== 'string'
    || typeof parsed.claimed_at !== 'number'
    || typeof parsed.owner_op !== 'string'
    || (parsed.claim_phase !== 'claimed' && parsed.claim_phase !== 'flipped')
  ) {
    return null;
  }
  const release = parsed.release_phase;
  if (
    release !== undefined
    && release !== 'restored'
    && release !== 'registry-restored'
    && release !== 'flipped'
    && release !== 'archived'
  ) {
    return null;
  }
  return parsed as unknown as ClaimManifest;
}

function readManifest(manifestPath: string): ClaimManifest | null {
  return readMarkerJson<ClaimManifest>(manifestPath, validateManifest);
}

/**
 * Atomic clean copy of a SQLite DB via VACUUM INTO. Produces a single
 * self-contained file (no WAL/SHM). Falls back to a raw byte copy when
 * the source is not a SQLite DB (test fixtures only).
 */
function snapshotSqliteFile(sourcePath: string, destPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source SQLite file does not exist: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }
  try {
    const db = openDatabase(sourcePath);
    try {
      const escaped = destPath.replace(/'/g, "''");
      db.run(`VACUUM INTO '${escaped}'`);
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('not a database') && !msg.includes('file is not a database')) {
      throw err;
    }
    fs.copyFileSync(sourcePath, destPath);
  }
}

/**
 * Replace a live SQLite file with the snapshot. Callers must hold the
 * Grove's pause set; no DB connection may be open against `destPath`.
 * Also removes `-wal` / `-shm` sidecars so a stale journal can't
 * reattach.
 */
function restoreSqliteFile(snapshotPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Unlink WAL/SHM before overwriting main DB — no stale-sidecar window.
  for (const sidecar of [`${destPath}-wal`, `${destPath}-shm`]) {
    try {
      fs.unlinkSync(sidecar);
    } catch {
      // Sidecar may not exist.
    }
  }
  fs.copyFileSync(snapshotPath, destPath);
}

/** Registry-file filter: TOML/YAML metadata only; excludes DBs, journals, dumps. */
function isRegistryFile(name: string): boolean {
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
      if (entry.name === 'projects.toml') {
        copyProjectsTomlStrippingPauses(source, dest);
      } else {
        fs.copyFileSync(source, dest);
      }
    }
  }
}

/**
 * Copies `projects.toml` but strips `[projects.<id>.paused]` blocks.
 * Pauses are transient operational state; on rollback the release runs
 * its own pause/resume cycle and shouldn't replay the claim's own pauses.
 */
function copyProjectsTomlStrippingPauses(source: string, dest: string): void {
  const raw = fs.readFileSync(source, 'utf-8');
  const stripped = raw.replace(/\n\[projects\.[^\.\]]+\.paused\][^\[]*/g, '\n');
  fs.writeFileSync(dest, stripped, 'utf-8');
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

/** Recursive directory-size walk. Best-effort: unreadable entries count as zero. */
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

function pruneArchivesOlderThan(archiveRoot: string, cutoffMs: number): void {
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
 * phase resumes from after the snapshot; in `flipped` phase it is a
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

  const backupsRoot = resolveBackupsRoot(options.backupsRoot);
  const existing = findOpenClaim(backupsRoot, grove.slug);

  if (existing) {
    if (existing.manifest.grove_id !== grove.id) {
      throw new Error(
        `An open claim manifest exists for slug ${grove.slug} but its grove_id `
        + `(${existing.manifest.grove_id}) does not match the resolved Grove (${grove.id})`,
      );
    }
    if (existing.manifest.release_phase !== undefined) {
      throw new Error(
        `A release is mid-flight for Grove ${grove.slug} (release_phase=${existing.manifest.release_phase}). `
        + `Run \`myco grove release ${grove.slug}\` to finish it before re-claiming.`,
      );
    }
    if (existing.manifest.claim_phase === 'flipped') {
      return {
        grove,
        manifest: existing.manifest,
        manifest_path: existing.manifestPath,
        snapshot_size_summary: summarizeSnapshotSize(existing.manifest),
      };
    }
    if (existing.manifest.claim_phase === 'claimed') {
      return resumeClaimFromManifest(grove, existing, mycoHome);
    }
    throw new Error(`Unexpected claim phase: ${existing.manifest.claim_phase}`);
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
    schema: CLAIM_MANIFEST_SCHEMA,
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
    claim_phase: 'claimed',
  };
  writeManifest(manifestPath, manifest);

  setGroveServedBy(grove.id, 'service-dev', mycoHome);
  manifest = { ...manifest, claim_phase: 'flipped' };
  writeManifest(manifestPath, manifest);

  for (const id of pausedProjectIds) {
    try {
      resumeProject(grove.id, id, ownerOp, mycoHome);
    } catch {
      // A pause taken by this op should always be resumable; swallow
      // benign already-resumed states.
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
    const next: ClaimManifest = { ...state.manifest, claim_phase: 'flipped' };
    writeManifest(state.manifestPath, next);
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
 * Identify Grove ID directories the registry snapshot held at claim time.
 * Each subdirectory of `snapshot_registry_dir` whose name begins with
 * `grove_` is a Grove. The cross-Grove `registry.yaml` lives at the top
 * level.
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
 * overwriting any registry files already there. DB files are untouched.
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

/** Restore the cross-Grove `registry.yaml` (default_grove_id pointer). */
function restoreCrossGroveRegistry(snapshotRegistryDir: string, mycoHome: string): void {
  const src = path.join(snapshotRegistryDir, 'registry.yaml');
  if (!fs.existsSync(src)) return;
  const dest = path.join(resolveGrovesDir(mycoHome), 'registry.yaml');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Restore every snapshotted project's vault manifests. Skips any project
 * whose vault directory no longer exists at restore time (warns but does
 * not fail the release).
 */
function restoreProjectManifests(snapshotProjectManifestsDir: string): void {
  if (!fs.existsSync(snapshotProjectManifestsDir)) return;
  for (const entry of fs.readdirSync(snapshotProjectManifestsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    const projectSnapshotDir = path.join(snapshotProjectManifestsDir, projectId);
    const projectRoot = findProjectRootInSnapshot(
      path.join(path.dirname(snapshotProjectManifestsDir), SNAPSHOT_REGISTRY_DIRNAME),
      projectId,
    );
    if (!projectRoot) continue;
    const vaultDir = resolveProjectVaultDir(projectRoot);
    if (!fs.existsSync(vaultDir)) {
      process.stderr.write(
        `warn: project vault ${vaultDir} (id ${projectId}) missing; skipping manifest restore\n`,
      );
      continue;
    }
    const snapshotManifest = path.join(projectSnapshotDir, PROJECT_MANIFEST_FILENAME);
    const snapshotLocal = path.join(projectSnapshotDir, PROJECT_LOCAL_MANIFEST_FILENAME);
    if (!fs.existsSync(snapshotManifest)) continue;
    // Restore goes through ProjectVault so the snapshot is validated by
    // the schema (no corrupted-snapshot landings) and the gitignore +
    // mtime cache stay coherent. A raw fs.copyFileSync would bypass
    // both — exactly the bug class the capability exists to close.
    const manifest = parseProjectManifest(fs.readFileSync(snapshotManifest, 'utf-8'));
    const localManifest = fs.existsSync(snapshotLocal)
      ? ProjectLocalManifestSchema.parse(parse(fs.readFileSync(snapshotLocal, 'utf-8')))
      : undefined;
    new ProjectVault(projectRoot).writeIdentity({
      manifest,
      ...(localManifest ? { localManifest } : { preserveLocalManifest: false }),
    });
  }
}

/**
 * Scan the snapshot registry for a project's recorded `root` field by
 * reading each Grove's `registry/projects.toml` until the project is
 * found.
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
    // Lightweight TOML scan to avoid pulling the parser here.
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
 * project moves reverted via registry + vault-manifest restore), flips
 * `served_by` back to the original, archives the claim directory.
 *
 * Idempotent on `release_phase` transitions:
 *   undefined → 'restored' → 'registry-restored' → 'flipped' → 'archived'.
 */
export function releaseClaimedGrove(
  groveId: string,
  mycoHome: string = resolveMycoHome(),
  options: ClaimOptions = {},
): ReleaseResult {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const backupsRoot = resolveBackupsRoot(options.backupsRoot);
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
  if (manifest !== open.manifest) writeManifest(open.manifestPath, manifest);

  // Pause every project across every Grove for the restore window.
  // Registry-restore writes Grove projects.toml files; a concurrent
  // write to a non-claimed Grove's registry would otherwise race.
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

    if (manifest.release_phase === undefined) {
      restoreSqliteFile(manifest.snapshot_db_path, dbPath);
      if (manifest.snapshot_vectors_path && fs.existsSync(manifest.snapshot_vectors_path)) {
        restoreSqliteFile(manifest.snapshot_vectors_path, vectorsPath);
      }
      manifest = { ...manifest, release_phase: 'restored' };
      writeManifest(open.manifestPath, manifest);
    }

    if (manifest.release_phase === 'restored') {
      restoreRegistryState(manifest, mycoHome);
      manifest = { ...manifest, release_phase: 'registry-restored' };
      writeManifest(open.manifestPath, manifest);
    }

    if (manifest.release_phase === 'registry-restored') {
      setGroveServedBy(grove.id, manifest.original_served_by, mycoHome);
      manifest = { ...manifest, release_phase: 'flipped' };
      writeManifest(open.manifestPath, manifest);
    }

    // Archive phase: the rename relocates the manifest itself. Checkpoint
    // first so a crash mid-rename leaves the manifest flagged 'archived';
    // resume below completes the rename even when 'archived' is already set
    // (handles the "checkpointed but didn't rename" crash window).
    const archiveRoot = groveArchiveDir(backupsRoot, grove.slug);
    const archiveTarget = path.join(archiveRoot, path.basename(open.claimRoot));
    if (manifest.release_phase !== 'archived') {
      fs.mkdirSync(archiveRoot, { recursive: true });
      manifest = { ...manifest, release_phase: 'archived' };
      writeManifest(open.manifestPath, manifest);
    }

    if (fs.existsSync(open.claimRoot)) {
      fs.mkdirSync(archiveRoot, { recursive: true });
      try {
        fs.renameSync(open.claimRoot, archiveTarget);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          fs.rmSync(open.claimRoot, { recursive: true, force: true });
        } else {
          throw err;
        }
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
 * Limitation: for Groves that existed at claim time and still exist
 * now, only registry files are restored — the Grove's DB is not. A move
 * during the claim window into a pre-existing destination Grove leaves
 * the duplicate row set in that Grove's DB.
 */
function restoreRegistryState(manifest: ClaimManifest, mycoHome: string): void {
  const snapshotGroveIds = new Set(listSnapshotGroveIds(manifest.snapshot_registry_dir));
  const liveGroveIds = new Set(listLiveGroveIds(mycoHome));

  // New Groves (live but not in snapshot) — delete with force=true so
  // any post-claim bound projects detach cleanly. The vault-manifest
  // restore below repoints them to their snapshotted Grove.
  for (const liveId of liveGroveIds) {
    if (snapshotGroveIds.has(liveId)) continue;
    try {
      deleteGrove(liveId, { force: true }, mycoHome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warn: failed to delete new Grove ${liveId} on release: ${msg}\n`);
    }
  }

  // Snapshotted Groves missing from disk — restore their registry files.
  // DB is not restored (other-Grove DB snapshots are out of scope).
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

  restoreCrossGroveRegistry(manifest.snapshot_registry_dir, mycoHome);
  restoreProjectManifests(manifest.snapshot_project_manifests_dir);

  // We wrote registry files directly, bypassing the helpers that
  // invalidate caches; drop everything so subsequent reads see disk.
  clearGroveRegistryCaches();
}
