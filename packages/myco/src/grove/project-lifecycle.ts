import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { openDatabase } from '@myco/db/client.js';
import { TEAM_SYNC_OBSERVED_TABLES } from '@myco/db/queries/team-outbox.js';
import { createBackup, pruneBackups } from '@myco/daemon/backup.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { getTeamMachineId, isTeamSyncEnabled } from '@myco/daemon/team-context.js';
import { loadGroveConfig } from '@myco/config/loader.js';
import { epochSeconds } from '@myco/constants.js';
import { ensureGroveDatabase } from './database.js';
import {
  resolveGroveDir,
  resolveGroveDbPath,
  resolveMycoHome,
} from './paths.js';
import {
  archiveProjectInGrove,
  deregisterProjectInGrove,
  getRegisteredProjectInGrove,
  loadGroveRecord,
  unarchiveProjectInGrove,
  type RegisteredProject,
} from './registry.js';

export interface ProjectLifecycleResult {
  grove_id: string;
  project_id: string;
  project_name: string;
  status: RegisteredProject['status'];
  archived_at?: string;
}

export interface DeleteProjectResult {
  grove_id: string;
  project_id: string;
  project_name: string;
  snapshot_path: string;
  table_counts: Record<string, number>;
  tombstones_enqueued: number;
}

const SYNC_DELETE_TABLE_SET = new Set<string>(TEAM_SYNC_OBSERVED_TABLES);

export function archiveProject(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectLifecycleResult {
  const project = archiveProjectInGrove(groveId, projectId, mycoHome);
  return lifecycleResult(groveId, project);
}

export function unarchiveProject(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectLifecycleResult {
  const project = unarchiveProjectInGrove(groveId, projectId, mycoHome);
  return lifecycleResult(groveId, project);
}

export function deleteProjectPermanently(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): DeleteProjectResult {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);
  const project = getRegisteredProjectInGrove(groveId, projectId, mycoHome, { includeArchived: true });
  if (!project) throw new Error(`Project ${projectId} is not registered in Grove ${groveId}`);

  ensureGroveDatabase(groveId, mycoHome);
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  const groveConfig = loadGroveConfig(grove.id, mycoHome);
  const backupDir = resolveGroveBackupDirForDelete(grove.slug, grove.id, groveConfig.backup.dir, mycoHome);

  const db = openDatabase(dbPath);
  try {
    const snapshotPath = createBackup(
      db,
      backupDir,
      getMachineId(),
    );
    pruneBackups(backupDir, groveConfig.backup.retention);
    const tableCounts = countProjectRows(db, project.project_id);
    const tombstonesEnqueued = enqueueProjectDeleteTombstones(db, project.project_id);
    deleteProjectRows(db, project.project_id);
    deregisterProjectInGrove(groveId, project.project_id, mycoHome);
    return {
      grove_id: groveId,
      project_id: project.project_id,
      project_name: project.name,
      snapshot_path: snapshotPath,
      table_counts: tableCounts,
      tombstones_enqueued: tombstonesEnqueued,
    };
  } finally {
    db.close();
  }
}

function resolveGroveBackupDirForDelete(
  groveSlug: string,
  groveId: string,
  configuredDir: string | undefined,
  mycoHome: string,
): string {
  if (!configuredDir) return path.resolve(resolveGroveDir(groveId, mycoHome), 'backups');
  const expanded = configuredDir.startsWith('~/')
    ? path.join(os.homedir(), configuredDir.slice(2))
    : configuredDir;
  return path.join(path.resolve(expanded), groveSlug);
}

function lifecycleResult(groveId: string, project: RegisteredProject): ProjectLifecycleResult {
  return {
    grove_id: groveId,
    project_id: project.project_id,
    project_name: project.name,
    status: project.status,
    ...(project.archived_at ? { archived_at: project.archived_at } : {}),
  };
}

function countProjectRows(db: Database, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of GROVE_PROJECT_SCOPED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
        .get(projectId) as { n: number } | undefined;
      counts[table] = row?.n ?? 0;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

function enqueueProjectDeleteTombstones(db: Database, projectId: string): number {
  if (!isTeamSyncEnabled()) return 0;
  const machineId = getTeamMachineId();
  const now = epochSeconds();
  let total = 0;

  const insert = db.prepare(
    `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
     VALUES (?, ?, 'delete', ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const table of GROVE_PROJECT_SCOPED_TABLES) {
      if (!SYNC_DELETE_TABLE_SET.has(table)) continue;
      if (!tableHasColumn(db, table, 'id')) continue;
      let rows: Array<{ id: string | number }> = [];
      try {
        rows = db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).all(projectId) as Array<{ id: string | number }>;
      } catch {
        continue;
      }
      for (const row of rows) {
        insert.run(
          table,
          String(row.id),
          JSON.stringify({ id: row.id, project_id: projectId, machine_id: machineId }),
          machineId,
          now,
        );
        total += 1;
      }
    }
  });
  tx();
  return total;
}

function deleteProjectRows(db: Database, projectId: string): void {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      for (const table of GROVE_PROJECT_SCOPED_TABLES) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
        } catch {
          // Older or partially initialized Grove DBs may not have every table.
        }
      }
    });
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}
