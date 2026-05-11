/**
 * moveProjectBetweenGroves — relocate a registered project's data and
 * binding from one Grove to another on the same machine.
 *
 * State machine, recorded on a marker file under
 * `<projectVaultDir>/.myco/migration/<moveOpId>.json` so a crash mid-move
 * is recoverable on the next call:
 *
 *   pause → snapshot → snapshot_complete → restored → verified
 *     → committed → cleaned → completed
 *
 * The marker is the source of truth for resumability. A marker for the
 * same (project, from, to) tuple is resumed; any other open marker
 * refuses to proceed.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { openDatabase } from '@myco/db/client.js';
import {
  saveProjectManifest,
  saveProjectLocalManifest,
} from '@myco/config/project-manifest.js';
import {
  BACKUP_TABLES,
  createBackup,
  restoreBackup,
} from '@myco/daemon/backup.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import {
  assertGroveProjectId,
  createGroveBindingId,
  projectScope,
  projectUrlSlug,
} from './ids.js';
import { ensureGroveDatabase } from './database.js';
import { findMarkerFiles, readMarkerJson, writeMarkerJson } from './marker.js';
import {
  resolveBackupsRoot,
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
} from './paths.js';
import {
  deregisterProjectInGrove,
  getRegisteredProjectInGrove,
  loadGroveRecord,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from './registry.js';

type MovePhase =
  | 'snapshot'
  | 'snapshot_complete'
  | 'restored'
  | 'verified'
  | 'committed'
  | 'cleaned'
  | 'completed';

interface MoveMarker {
  move_op_id: string;
  from_grove_id: string;
  to_grove_id: string;
  project_id: string;
  project_name: string;
  project_root: string;
  started_at: string;
  phase: MovePhase;
  snapshot_path?: string;
  table_counts?: Record<string, number>;
  new_binding_id?: string;
}

export interface MoveResult {
  from_grove_id: string;
  to_grove_id: string;
  project_id: string;
  snapshot_path: string;
  table_counts: Record<string, number>;
}

const PROJECT_SCOPED_TABLE_SET = new Set<string>(GROVE_PROJECT_SCOPED_TABLES);

/**
 * Tables iterated for the verify/clean phases. Drawn from BACKUP_TABLES
 * intersected with the project-scoped set so `team_members` (grove-
 * scoped, not project-scoped) is not deleted from the source — moves
 * only relocate project data.
 */
const MOVE_SCOPED_TABLES = BACKUP_TABLES.filter((t) => PROJECT_SCOPED_TABLE_SET.has(t));

export interface MoveProjectOptions {
  /**
   * Override the directory snapshots are written under. Defaults to
   * `~/myco_backups/<projectSlug>/<moveOpId>/`. Tests pass an explicit
   * value so backup files don't escape the test sandbox.
   */
  snapshotsRoot?: string;
}

export function moveProjectBetweenGroves(
  sourceGroveId: string,
  targetGroveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
  options: MoveProjectOptions = {},
): MoveResult {
  if (sourceGroveId === targetGroveId) {
    throw new Error('moveProjectBetweenGroves: source and target Grove ids must differ');
  }

  const sourceGrove = loadGroveRecord(sourceGroveId, mycoHome);
  if (!sourceGrove) throw new Error(`Unknown source Grove: ${sourceGroveId}`);

  const targetGrove = loadGroveRecord(targetGroveId, mycoHome);
  if (!targetGrove) {
    throw new Error(
      `Target Grove ${targetGroveId} is not registered locally. `
      + `Create it explicitly before moving — moves do not auto-provision.`,
    );
  }

  // Source-or-target registry lookup. Past the commit phase the
  // project has already been deregistered from source, so on resume
  // we may have to read it off the target instead.
  const sourceEntry = getRegisteredProjectInGrove(sourceGroveId, projectId, mycoHome);
  const targetEntry = getRegisteredProjectInGrove(targetGroveId, projectId, mycoHome);
  const registryEntry = sourceEntry ?? targetEntry;
  if (!registryEntry) {
    throw new Error(`Project ${projectId} is not registered in Grove ${sourceGroveId}`);
  }

  const projectRoot = registryEntry.root;
  const projectName = registryEntry.name;
  const vaultDir = resolveProjectVaultDir(projectRoot);
  const projectSlug = projectUrlSlug(projectName, projectId);
  const brandedProjectId = assertGroveProjectId(projectId);

  const migrationDir = path.join(vaultDir, 'migration');
  fs.mkdirSync(migrationDir, { recursive: true });

  const existingMarker = findExistingMarkerForProject(migrationDir, projectId);
  const completedMarker = findCompletedMarkerForProject(migrationDir, projectId);

  if (existingMarker && (
    existingMarker.from_grove_id !== sourceGroveId
    || existingMarker.to_grove_id !== targetGroveId
  )) {
    throw new Error(
      `In-progress move marker for ${projectId} targets a different Grove pair `
      + `(${existingMarker.from_grove_id} → ${existingMarker.to_grove_id}); `
      + `cannot resume as ${sourceGroveId} → ${targetGroveId}`,
    );
  }
  const otherMarker = findMarkerForOtherProject(migrationDir, projectId);
  if (otherMarker) {
    throw new Error(
      `In-progress move marker for a different project (${otherMarker.project_id}) `
      + `exists in this vault; complete or remove it before starting another move`,
    );
  }

  // Already-completed move for this from→to pair: idempotent return.
  if (
    !existingMarker
    && completedMarker
    && completedMarker.from_grove_id === sourceGroveId
    && completedMarker.to_grove_id === targetGroveId
    && completedMarker.snapshot_path
    && completedMarker.table_counts
  ) {
    return {
      from_grove_id: sourceGroveId,
      to_grove_id: targetGroveId,
      project_id: projectId,
      snapshot_path: completedMarker.snapshot_path,
      table_counts: completedMarker.table_counts,
    };
  }

  // From this point a non-completed move requires either the source
  // entry to exist, or the target entry to exist (resume after the
  // commit block ran — even partially — already deregistered source).
  // `registryEntry` above already has this OR semantics; the only
  // remaining bug shape is "no entry on either Grove and no resumable
  // marker", which is caught by the registryEntry null check earlier.
  if (!sourceEntry && !targetEntry) {
    throw new Error(`Project ${projectId} is not registered in Grove ${sourceGroveId}`);
  }

  const moveOpId = existingMarker?.move_op_id
    ?? `grove-move-${projectId}-${Date.now()}`;
  const markerPath = path.join(migrationDir, `${moveOpId}.json`);

  let marker: MoveMarker = existingMarker ?? {
    move_op_id: moveOpId,
    from_grove_id: sourceGroveId,
    to_grove_id: targetGroveId,
    project_id: projectId,
    project_name: projectName,
    project_root: projectRoot,
    started_at: new Date().toISOString(),
    phase: 'snapshot',
  };

  // Pause source. `pauseProject` is idempotent for the same owner_op
  // (refreshes `since`, no throw) so a fresh-after-crash resume re-takes
  // its own lock cleanly. A different owner_op on the lock is a real
  // conflict and surfaces.
  //
  // Skipped when the source entry is already gone — that is the resume
  // scenario where the commit block ran register+deregister but did not
  // advance the marker. pauseProject would throw "not registered" in
  // that case, but the pause's purpose (gating writes against the
  // source registry entry) is already met by the entry being absent.
  if (sourceEntry) {
    pauseProject(sourceGroveId, projectId, 'grove-move', moveOpId, mycoHome);
  }

  if (!fs.existsSync(markerPath)) writeMarker(markerPath, marker);

  const sourceDbPath = resolveGroveDbPath(sourceGroveId, mycoHome);
  const targetDbPath = resolveGroveDbPath(targetGroveId, mycoHome);

  const machineId = getMachineId(vaultDir);
  const snapshotsRoot = resolveBackupsRoot(options.snapshotsRoot);
  const snapshotDir = path.join(snapshotsRoot, projectSlug, moveOpId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  if (orderOf(marker.phase) <= orderOf('snapshot')) {
    const snapshotPath = withDb(sourceDbPath, (sourceDb) => {
      return createBackup(
        sourceDb,
        snapshotDir,
        machineId,
        projectScope(brandedProjectId),
        projectSlug,
      );
    });
    marker = { ...marker, phase: 'snapshot_complete', snapshot_path: snapshotPath };
    writeMarker(markerPath, marker);
  }

  const snapshotPath = marker.snapshot_path;
  if (!snapshotPath) {
    throw new Error('move marker advanced past snapshot but recorded no snapshot_path');
  }

  if (orderOf(marker.phase) <= orderOf('snapshot_complete')) {
    // Target DB may be uninitialized (Grove registered but never activated).
    // `openDatabase` only creates an empty file; restoreBackup needs the
    // schema present before its INSERT OR IGNORE statements run.
    ensureGroveDatabase(targetGroveId, mycoHome);
    withDb(targetDbPath, (targetDb) => {
      restoreBackup(targetDb, snapshotPath);
    });
    marker = { ...marker, phase: 'restored' };
    writeMarker(markerPath, marker);
  }

  let tableCounts: Record<string, number> = marker.table_counts ?? {};

  if (orderOf(marker.phase) <= orderOf('restored')) {
    const sourceCounts = withDb(sourceDbPath, (sourceDb) =>
      countProjectRows(sourceDb, projectId),
    );
    const targetCounts = withDb(targetDbPath, (targetDb) =>
      countProjectRows(targetDb, projectId),
    );

    const mismatches: string[] = [];
    for (const table of MOVE_SCOPED_TABLES) {
      const src = sourceCounts[table] ?? 0;
      const tgt = targetCounts[table] ?? 0;
      if (src !== tgt) {
        mismatches.push(`${table}: source=${src}, target=${tgt}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `move verification failed for project ${projectId}: ${mismatches.join('; ')}`,
      );
    }

    tableCounts = {};
    for (const [table, count] of Object.entries(sourceCounts)) {
      if (count > 0) tableCounts[table] = count;
    }

    marker = { ...marker, phase: 'verified', table_counts: tableCounts };
    writeMarker(markerPath, marker);
  }

  if (orderOf(marker.phase) <= orderOf('verified')) {
    const newBindingId = marker.new_binding_id ?? createGroveBindingId();
    // registerProjectInGrove merges with any existing entry (preserves
    // created_at, refreshes updated_at), so a resume after a partial
    // commit is idempotent on the target side.
    registerProjectInGrove(targetGroveId, {
      projectId,
      projectName,
      projectRoot,
      bindingId: newBindingId,
    }, mycoHome);
    // force: idempotent on resume after a partial commit
    deregisterProjectInGrove(sourceGroveId, projectId, mycoHome, { force: true });
    saveProjectManifest(vaultDir, {
      project: { id: projectId, name: projectName },
      grove: {
        id: targetGroveId,
        slug: targetGrove.slug,
        name: targetGrove.name,
        mode: 'local',
      },
    });
    saveProjectLocalManifest(vaultDir, {
      grove_binding: { binding_id: newBindingId, mode: 'local' },
    });
    marker = { ...marker, phase: 'committed', new_binding_id: newBindingId };
    writeMarker(markerPath, marker);
  }

  if (orderOf(marker.phase) <= orderOf('committed')) {
    withDb(sourceDbPath, (sourceDb) => {
      deleteProjectRows(sourceDb, projectId);
    });
    marker = { ...marker, phase: 'cleaned' };
    writeMarker(markerPath, marker);
  }

  if (orderOf(marker.phase) <= orderOf('cleaned')) {
    // Pause was on source's projects.toml entry; deregister already
    // dropped the entry. resumeProject on target is a no-op-on-unpaused
    // path, included for symmetry so future ops see a clean slate.
    resumeProject(targetGroveId, projectId, moveOpId, mycoHome);
    marker = { ...marker, phase: 'completed' };
    writeMarker(markerPath, marker);
  }

  return {
    from_grove_id: sourceGroveId,
    to_grove_id: targetGroveId,
    project_id: projectId,
    snapshot_path: snapshotPath,
    table_counts: marker.table_counts ?? tableCounts,
  };
}

const PHASE_ORDER: MovePhase[] = [
  'snapshot',
  'snapshot_complete',
  'restored',
  'verified',
  'committed',
  'cleaned',
  'completed',
];

function orderOf(phase: MovePhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function writeMarker(markerPath: string, marker: MoveMarker): void {
  writeMarkerJson(markerPath, marker);
}

function validateMarker(raw: unknown): MoveMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<MoveMarker>;
  if (
    typeof parsed.move_op_id !== 'string'
    || typeof parsed.from_grove_id !== 'string'
    || typeof parsed.to_grove_id !== 'string'
    || typeof parsed.project_id !== 'string'
    || typeof parsed.started_at !== 'string'
    || typeof parsed.phase !== 'string'
    || !PHASE_ORDER.includes(parsed.phase as MovePhase)
  ) {
    return null;
  }
  return {
    move_op_id: parsed.move_op_id,
    from_grove_id: parsed.from_grove_id,
    to_grove_id: parsed.to_grove_id,
    project_id: parsed.project_id,
    project_name: typeof parsed.project_name === 'string' ? parsed.project_name : '',
    project_root: typeof parsed.project_root === 'string' ? parsed.project_root : '',
    started_at: parsed.started_at,
    phase: parsed.phase as MovePhase,
    ...(typeof parsed.snapshot_path === 'string' ? { snapshot_path: parsed.snapshot_path } : {}),
    ...(parsed.table_counts ? { table_counts: parsed.table_counts as Record<string, number> } : {}),
    ...(typeof parsed.new_binding_id === 'string' ? { new_binding_id: parsed.new_binding_id } : {}),
  };
}

function readMarker(markerPath: string): MoveMarker | null {
  return readMarkerJson<MoveMarker>(markerPath, validateMarker);
}

function findExistingMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (parsed && parsed.project_id === projectId && parsed.phase !== 'completed') {
      return parsed;
    }
  }
  return null;
}

function findCompletedMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  let latest: MoveMarker | null = null;
  let latestStarted = '';
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (!parsed || parsed.project_id !== projectId) continue;
    if (parsed.phase !== 'completed') continue;
    if (parsed.started_at > latestStarted) {
      latest = parsed;
      latestStarted = parsed.started_at;
    }
  }
  return latest;
}

function findMarkerForOtherProject(migrationDir: string, projectId: string): MoveMarker | null {
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (parsed && parsed.project_id !== projectId && parsed.phase !== 'completed') {
      return parsed;
    }
  }
  return null;
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    // Move snapshot/restore/verify all run against an existing schema.
    // We open with a dedicated connection so the daemon's process-wide
    // singleton (if active in the same process) is unaffected.
    return fn(db);
  } finally {
    db.close();
  }
}

function countProjectRows(db: Database, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of MOVE_SCOPED_TABLES) {
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
      ).get(projectId) as { n: number } | undefined;
      counts[table] = row?.n ?? 0;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

function deleteProjectRows(db: Database, projectId: string): void {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      for (const table of MOVE_SCOPED_TABLES) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
        } catch {
          // Table may not exist on a brand-new target Grove DB; skip.
        }
      }
      // `entity_mentions` is project-scoped but excluded from BACKUP_TABLES
      // (no `id` column makes it incompatible with the INSERT OR IGNORE
      // round-trip; see gotcha_entity_mentions_not_synced.md). Its rows
      // are not snapshotted and not restored on the target, so we delete
      // them from source explicitly here — the moved project must leave
      // no orphans behind.
      try {
        db.prepare(`DELETE FROM entity_mentions WHERE project_id = ?`).run(projectId);
      } catch {
        // Table may not exist on older schemas; skip.
      }
    });
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}
