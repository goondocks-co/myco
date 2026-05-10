/**
 * moveProjectBetweenGroves — relocate a registered project's data and
 * binding from one Grove to another on the same machine.
 *
 * Phases (recorded on a marker file under
 * `<projectVaultDir>/.myco/migration/<moveOpId>.json` so a crash mid-move
 * is recoverable on the next call):
 *
 *   pause -> snapshot -> snapshot_complete -> restored -> verified
 *     -> committed -> cleaned -> completed
 *
 * The marker is the source of truth for resumability. If a marker exists
 * for the same project on entry, the orchestrator picks up from the
 * recorded phase. A marker for a different project (or a different
 * source/target pair) refuses to proceed.
 */

import fs from 'node:fs';
import os from 'node:os';
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
import {
  assertGroveProjectId,
  createGroveBindingId,
  projectScope,
  projectUrlSlug,
} from './ids.js';
import {
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

  // From this point a non-completed move requires the source entry to
  // exist OR the marker to be past the commit phase (which already
  // deregistered the source entry). Anything else is a bug.
  if (!sourceEntry && (!existingMarker || orderOf(existingMarker.phase) < orderOf('committed'))) {
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

  // Pause source. Idempotent for the same owner_op so resume after a
  // crash does not throw on a still-held lock.
  try {
    pauseProject(sourceGroveId, projectId, 'grove-move', moveOpId, mycoHome);
  } catch (err) {
    // If the project was already deregistered (resume after committed
    // phase), pauseProject throws "not registered". That's expected on
    // resume past commit; continue.
    const phase = marker.phase;
    if (phase !== 'committed' && phase !== 'cleaned') throw err;
  }

  if (!fs.existsSync(markerPath)) writeMarker(markerPath, marker);

  const sourceDbPath = resolveGroveDbPath(sourceGroveId, mycoHome);
  const targetDbPath = resolveGroveDbPath(targetGroveId, mycoHome);

  const machineId = readMachineId(vaultDir);
  const snapshotsRoot = options.snapshotsRoot
    ?? path.join(os.homedir(), 'myco_backups');
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
    registerProjectInGrove(targetGroveId, {
      projectId,
      projectName,
      projectRoot,
      bindingId: newBindingId,
    }, mycoHome);
    deregisterProjectInGrove(sourceGroveId, projectId, mycoHome);
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
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
}

function findExistingMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  if (!fs.existsSync(migrationDir)) return null;
  for (const entry of fs.readdirSync(migrationDir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(migrationDir, entry);
    const parsed = readMarker(full);
    if (parsed && parsed.project_id === projectId && parsed.phase !== 'completed') {
      return parsed;
    }
  }
  return null;
}

function findCompletedMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  if (!fs.existsSync(migrationDir)) return null;
  let latest: MoveMarker | null = null;
  let latestStarted = '';
  for (const entry of fs.readdirSync(migrationDir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(migrationDir, entry);
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
  if (!fs.existsSync(migrationDir)) return null;
  for (const entry of fs.readdirSync(migrationDir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(migrationDir, entry);
    const parsed = readMarker(full);
    if (parsed && parsed.project_id !== projectId && parsed.phase !== 'completed') {
      return parsed;
    }
  }
  return null;
}

function readMarker(markerPath: string): MoveMarker | null {
  try {
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MoveMarker>;
    if (
      typeof parsed.move_op_id === 'string'
      && typeof parsed.from_grove_id === 'string'
      && typeof parsed.to_grove_id === 'string'
      && typeof parsed.project_id === 'string'
      && typeof parsed.started_at === 'string'
      && typeof parsed.phase === 'string'
      && PHASE_ORDER.includes(parsed.phase as MovePhase)
    ) {
      const result: MoveMarker = {
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
      return result;
    }
  } catch {
    return null;
  }
  return null;
}

function readMachineId(vaultDir: string): string {
  const cachePath = path.join(vaultDir, 'machine_id');
  try {
    const cached = fs.readFileSync(cachePath, 'utf-8').trim();
    if (cached.length > 0) return cached;
  } catch {
    // fall through
  }
  const fallback = 'move-orchestrator_local';
  return fallback;
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
    });
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}
