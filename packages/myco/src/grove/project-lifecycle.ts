import type { Database } from 'bun:sqlite';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { openDatabase } from '@myco/db/client.js';
import { createGroveBackup } from '@myco/backup/service.js';
import { getMachineId } from '@myco/machine-id.js';
import fs from 'node:fs';
import { ensureGroveDatabase } from './database.js';
import {
  resolveGroveDbPath,
  resolveGroveProjectDir,
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
import { ensureProjectVault } from '../vault/provision.js';
import { ProjectVault } from '../vault/project-vault.js';

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
}

export function archiveProject(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectLifecycleResult {
  const project = archiveProjectInGrove(groveId, projectId, mycoHome);
  tryRemoveProjectVault(project.root, 'archive', project.project_id);
  return lifecycleResult(groveId, project);
}

export function unarchiveProject(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectLifecycleResult {
  const project = unarchiveProjectInGrove(groveId, projectId, mycoHome);
  try {
    ensureProjectVault(project.root, { projectName: project.name, force: true });
  } catch (err) {
    process.stderr.write(
      `[myco] project unarchive could not re-provision project vault project_id=${project.project_id}: ${(err as Error).message}\n`,
    );
  }
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

  const db = openDatabase(dbPath);
  try {
    // Delete-safety snapshot — a whole-Grove backup into the Grove's
    // canonical dir, via the same service the manual/auto paths use.
    const { file_path: snapshotPath } = createGroveBackup({
      groveId: grove.id,
      db,
      machineId: getMachineId(),
      mycoHome,
    });
    const tableCounts = countProjectRows(db, project.project_id);
    // Each `DELETE FROM <table> WHERE project_id = ?` in deleteProjectRows fires
    // that table's `_team_ad` trigger, but the trigger is membership-gated
    // (`WHEN OLD.project_id IN (SELECT project_id FROM team_sync_membership)`)
    // and nothing in this codepath — or anywhere else in src — populates
    // team_sync_membership anymore, so the trigger never matches and no
    // team_outbox rows are journaled.
    deleteProjectRows(db, project.project_id);
    deregisterProjectInGrove(groveId, project.project_id, mycoHome);
    // Remove the Grove-side project dir (buffer/ and any per-project
    // artifacts). With the rows, tombstones, AND buffer files gone
    // together, a later re-register of the same project id presents zero
    // resurrection candidates. The whole-Grove snapshot taken above is a
    // SQL dump of DB tables only — buffer .jsonl files are NOT captured,
    // so unconverged buffered events in this dir are destroyed by design;
    // only rows already in the DB are recoverable from the snapshot.
    tryRemoveGroveProjectDir(groveId, project.project_id, mycoHome);
    tryRemoveProjectVault(project.root, 'delete', project.project_id);
    return {
      grove_id: groveId,
      project_id: project.project_id,
      project_name: project.name,
      snapshot_path: snapshotPath,
      table_counts: tableCounts,
    };
  } finally {
    db.close();
  }
}

export function removeProjectVault(projectRoot: string): void {
  ProjectVault.atRoot(projectRoot).removeManagedProjectFiles();
}

function tryRemoveGroveProjectDir(groveId: string, projectId: string, mycoHome: string): void {
  try {
    fs.rmSync(resolveGroveProjectDir(groveId, projectId, mycoHome), { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[myco] project delete could not remove Grove project dir project_id=${projectId}: ${(err as Error).message}\n`,
    );
  }
}

function tryRemoveProjectVault(projectRoot: string, action: 'archive' | 'delete', projectId: string): void {
  try {
    removeProjectVault(projectRoot);
  } catch (err) {
    process.stderr.write(
      `[myco] project ${action} could not remove project vault project_id=${projectId}: ${(err as Error).message}\n`,
    );
  }
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
