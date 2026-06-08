import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import {
  createBackup,
  projectScope,
  readSnapshotHeader,
  restoreBackup,
} from '@myco/backup/engine.js';
import { getMachineId } from '@myco/machine-id.js';
import {
  resolveBackupsRoot,
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import { findRegisteredProject, isProjectPaused } from '@myco/grove/registry.js';
import { assertGroveProjectId, projectUrlSlug } from '@myco/grove/ids.js';
import { findProjectByRef } from './grove.js';

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

    const paused = isProjectPaused(found.project.project_id, mycoHome);
    if (paused.paused) {
      console.error(`Project is paused: ${paused.reason} (since ${new Date(paused.since * 1000).toISOString()}, owner_op: ${paused.owner_op})`);
      console.error(`Wait for the operation to complete or check the daemon logs.`);
      process.exit(1);
    }

    const vaultDir = resolveProjectVaultDir(found.project.root);
    const machineId = getMachineId();
    const slug = projectUrlSlug(found.project.name, found.project.project_id);
    const backupDir = path.join(resolveBackupsRoot(), slug);
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

    const paused = isProjectPaused(found.project.project_id, mycoHome);
    if (paused.paused) {
      console.error(`Project is paused: ${paused.reason} (since ${new Date(paused.since * 1000).toISOString()}, owner_op: ${paused.owner_op})`);
      console.error(`Wait for the operation to complete or check the daemon logs.`);
      process.exit(1);
    }

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
