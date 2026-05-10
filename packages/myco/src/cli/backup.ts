import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import {
  createBackup,
  projectScope,
  readSnapshotHeader,
  restoreBackup,
} from '@myco/daemon/backup.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { resolveGroveDbPath, resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { findRegisteredProject } from '@myco/grove/registry.js';
import { assertGroveProjectId, projectUrlSlug } from '@myco/grove/ids.js';
import { findProjectByRef } from './grove.js';

/**
 * Root directory for project-scoped backup snapshots. Defaults to
 * `~/myco_backups/`; tests override via MYCO_BACKUPS_DIR because
 * `os.homedir()` caches at process start and ignores later `HOME` changes.
 */
function resolveBackupRoot(): string {
  const override = process.env.MYCO_BACKUPS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), 'myco_backups');
}

const USAGE = `Usage: myco backup <command>

Commands:
  project <project-id-or-slug>   Snapshot a project's data to ~/myco_backups/<slug>/
  restore <snapshot-path>        Restore a project snapshot into its current Grove
`;

export async function run(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  const mycoHome = resolveMycoHome();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'project') {
    const projectRef = rest[0];
    if (!projectRef) throw new Error('Project id or slug is required');
    const found = findProjectByRef(projectRef, mycoHome);
    if (!found) throw new Error(`Project not found: ${projectRef}`);

    const vaultDir = resolveProjectVaultDir(found.project.root);
    const machineId = getMachineId(vaultDir);
    const slug = projectUrlSlug(found.project.name, found.project.project_id);
    const backupDir = path.join(resolveBackupRoot(), slug);
    fs.mkdirSync(backupDir, { recursive: true });

    const groveDbPath = resolveGroveDbPath(found.grove.id, mycoHome);
    const db = openDatabase(groveDbPath);
    try {
      const snapshotPath = createBackup(
        db,
        backupDir,
        machineId,
        projectScope(assertGroveProjectId(found.project.project_id)),
        slug,
      );
      const sizeBytes = fs.statSync(snapshotPath).size;
      console.log(`Snapshot: ${snapshotPath}`);
      console.log(`Size: ${(sizeBytes / 1024).toFixed(1)} KB`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === 'restore') {
    const snapshotPath = rest[0];
    if (!snapshotPath) throw new Error('Snapshot path is required');
    if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);

    const header = readSnapshotHeader(snapshotPath);
    if (!header.scope || header.scope.kind !== 'project') {
      throw new Error('Snapshot is not project-scoped; cannot restore via this command');
    }

    const projectId = header.scope.id;
    const found = findRegisteredProject({ projectId }, mycoHome);
    if (!found) throw new Error(`Snapshot project ${projectId} is not registered locally`);

    const groveDbPath = resolveGroveDbPath(found.grove.id, mycoHome);
    const db = openDatabase(groveDbPath);
    try {
      restoreBackup(db, snapshotPath);
      console.log(`Restored ${projectId} into Grove ${found.grove.name} (${found.grove.slug})`);
    } finally {
      db.close();
    }
    return;
  }

  throw new Error(`Unknown backup subcommand: ${cmd}`);
}
