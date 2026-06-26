import type { Database } from 'bun:sqlite';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { openDatabase } from '@myco/db/client.js';
import { createGroveBackup } from '@myco/backup/service.js';
import { getMachineId } from '@myco/machine-id.js';
import { loadGroveConfig } from '@myco/config/loader.js';
import { setTeamSyncEnabled, setProjectSyncMembership } from '@myco/db/queries/team-sync-state.js';
import { memberProjectIdsForGrove } from './project-tenancy.js';
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
  const groveConfig = loadGroveConfig(grove.id, mycoHome);

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
    // Reconcile the per-Grove team_sync_state flag from this Grove's config
    // before deleting rows. Without this, a freshly-opened DB handle (e.g.
    // before the first daemon flush tick) has no flag row, so the AFTER DELETE
    // triggers would silently skip journaling. Reconciling here guarantees the
    // trigger gate reflects the Grove's intent regardless of tick timing.
    setTeamSyncEnabled(groveConfig.team.enabled, db);
    // The delete triggers are also membership-gated (a delete journals only when
    // OLD.project_id is a member), so the per-project member set must be present
    // on this freshly-opened handle too — otherwise a member project's delete
    // would silently skip journaling.
    const memberResolution = memberProjectIdsForGrove(groveId);
    // Only write membership when the registry was successfully read. An
    // indeterminate read leaves the prior membership in place — that is the
    // best available outcome, since replacing it with a known-wrong empty
    // list would cause member-project deletes to silently skip D1 journaling.
    if (memberResolution.resolved) {
      setProjectSyncMembership(memberResolution.memberships, db);
    }
    // Each `DELETE FROM <table> WHERE project_id = ?` in deleteProjectRows
    // fires that table's `_team_ad` trigger, which journals the delete to
    // team_outbox when this Grove's team_sync_state.enabled = 1. No manual
    // tombstone enqueue is needed (it would double-journal).
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
