/**
 * Grove dogfood claim/release — flip a Grove's `served_by` between the
 * production daemon (`service`) and the dev daemon (`service-dev`), with
 * a full-Grove snapshot taken at claim time and replayed on release so
 * the production state is restored after dogfooding.
 *
 * Phases (recorded on a manifest file under
 * `<claimRoot>/claim.json` so a crash is recoverable on the next call):
 *
 *   claim:    pause -> snapshot -> manifest written (phase=claimed)
 *               -> served_by flipped (phase=flipped) -> resume (done)
 *   release:  pause -> purge+restore (phase=restored)
 *               -> served_by flipped (phase=flipped)
 *               -> archive (phase=archived) -> resume (done)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import {
  BACKUP_TABLES,
  createBackup,
  restoreBackup,
} from '@myco/daemon/backup.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { ALL_PROJECTS_SCOPE } from './ids.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
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
  schema: 1;
  grove_id: string;
  grove_slug: string;
  grove_name: string;
  original_served_by: DaemonVariant;
  snapshot_path: string;
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
const SNAPSHOT_FILENAME = 'grove-claim.sql';
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
    const parsed = JSON.parse(raw) as Partial<ClaimManifest>;
    if (
      parsed.schema === 1
      && typeof parsed.grove_id === 'string'
      && typeof parsed.grove_slug === 'string'
      && typeof parsed.grove_name === 'string'
      && (parsed.original_served_by === 'service' || parsed.original_served_by === 'service-dev')
      && typeof parsed.snapshot_path === 'string'
      && typeof parsed.claim_root === 'string'
      && typeof parsed.claimed_at === 'number'
      && typeof parsed.owner_op === 'string'
      && typeof parsed.phase === 'string'
    ) {
      return parsed as ClaimManifest;
    }
  } catch {
    return null;
  }
  return null;
}

function machineIdForGrove(grove: GroveRecord, mycoHome: string): string {
  const projects = listRegisteredProjects(grove.id, mycoHome);
  for (const project of projects) {
    try {
      const vaultDir = resolveProjectVaultDir(project.root);
      return getMachineId(vaultDir);
    } catch {
      // Try the next project.
    }
  }
  return 'grove-claim_local';
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
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

  const snapshotPath = path.join(claimRoot, SNAPSHOT_FILENAME);
  const machineId = machineIdForGrove(grove, mycoHome);
  const dbPath = resolveGroveDbPath(grove.id, mycoHome);

  try {
    const written = withDb(dbPath, (db) =>
      createBackup(db, claimRoot, machineId, ALL_PROJECTS_SCOPE),
    );
    if (written !== snapshotPath) {
      fs.renameSync(written, snapshotPath);
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
    schema: 1,
    grove_id: grove.id,
    grove_slug: grove.slug,
    grove_name: grove.name,
    original_served_by: grove.served_by,
    snapshot_path: snapshotPath,
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
  if (!fs.existsSync(open.manifest.snapshot_path)) {
    throw new Error(
      `Claim snapshot is missing at ${open.manifest.snapshot_path}; cannot restore. `
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

    if (manifest.phase === 'claimed' || manifest.phase === 'flipped') {
      withDb(dbPath, (db) => {
        purgeGroveTables(db, projects.map((p) => p.project_id));
        restoreBackup(db, manifest.snapshot_path);
      });
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

function purgeGroveTables(db: Database, projectIds: string[]): void {
  if (projectIds.length === 0) {
    // Still purge grove-scoped tables so a release on an empty Grove
    // doesn't leave stray team_members rows from dev experimentation.
    db.run('PRAGMA foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        for (const table of BACKUP_TABLES) {
          try {
            db.prepare(`DELETE FROM ${table}`).run();
          } catch {
            // Table may not exist.
          }
        }
        try {
          db.prepare(`DELETE FROM entity_mentions`).run();
        } catch {
          // Table may not exist.
        }
      });
      tx();
    } finally {
      db.run('PRAGMA foreign_keys = ON');
    }
    return;
  }

  const placeholders = projectIds.map(() => '?').join(', ');
  db.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      for (const table of BACKUP_TABLES) {
        try {
          if (table === 'team_members') {
            db.prepare(`DELETE FROM ${table}`).run();
          } else {
            db.prepare(
              `DELETE FROM ${table} WHERE project_id IN (${placeholders})`,
            ).run(...projectIds);
          }
        } catch {
          // Table may not exist on older schemas.
        }
      }
      try {
        db.prepare(
          `DELETE FROM entity_mentions WHERE project_id IN (${placeholders})`,
        ).run(...projectIds);
      } catch {
        // Table may not exist.
      }
    });
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}
