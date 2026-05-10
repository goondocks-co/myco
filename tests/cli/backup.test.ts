import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { createProjectId, projectUrlSlug } from '@myco/grove/ids.js';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/backup.js';

let tmpDir: string;
let home: string;
let backupsDir: string;
let projectRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-cli-'));
  home = path.join(tmpDir, 'myco-home');
  backupsDir = path.join(tmpDir, 'myco_backups');
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });

  process.env.MYCO_HOME = home;
  process.env.MYCO_BACKUPS_DIR = backupsDir;
  clearGroveRegistryCaches();
});

afterEach(() => {
  delete process.env.MYCO_HOME;
  delete process.env.MYCO_BACKUPS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function ensureGroveDb(groveId: string): void {
  const dbPath = resolveGroveDbPath(groveId, home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code', 'Claude Code', 'built-in', 1, 100);
  } finally {
    db.close();
  }
}

function seedProjectRows(groveId: string, projectId: string): void {
  const dbPath = resolveGroveDbPath(groveId, home);
  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO sessions (
         id, agent, project_root, branch, started_at, status, created_at,
         embedded, machine_id, project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `sess-${projectId}`,
      'claude-code',
      projectRoot,
      'main',
      200,
      'completed',
      200,
      1,
      'test-machine',
      projectId,
    );
  } finally {
    db.close();
  }
}

function setupProject(): { groveId: string; projectId: string; slug: string } {
  const grove = createGrove('Work', home);
  ensureGroveDb(grove.id);
  const projectId = createProjectId();
  registerProjectInGrove(grove.id, {
    projectId,
    projectName: 'Demo',
    projectRoot,
  }, home);
  seedProjectRows(grove.id, projectId);
  return { groveId: grove.id, projectId, slug: projectUrlSlug('Demo', projectId) };
}

describe('myco backup CLI', () => {
  it('writes a project snapshot under ~/myco_backups/<slug>/', async () => {
    const { projectId, slug } = setupProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['project', projectId]);

    const expectedDir = path.join(backupsDir, slug);
    expect(fs.existsSync(expectedDir)).toBe(true);
    const files = fs.readdirSync(expectedDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBe(1);

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Snapshot:');
    expect(output).toContain('Size:');

    log.mockRestore();
  });

  it('restores a project snapshot back into its Grove', async () => {
    const { groveId, projectId, slug } = setupProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['project', projectId]);

    const backupDir = path.join(backupsDir, slug);
    const sqlFile = fs.readdirSync(backupDir).find((f) => f.endsWith('.sql'))!;
    const snapshotPath = path.join(backupDir, sqlFile);

    // Wipe project-scoped rows from the Grove DB so restore has work to do.
    const dbPath = resolveGroveDbPath(groveId, home);
    const db = openDatabase(dbPath);
    try {
      db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId);
    } finally {
      db.close();
    }

    await run(['restore', snapshotPath]);

    const verify = openDatabase(dbPath);
    try {
      const row = verify.prepare(
        'SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?',
      ).get(projectId) as { n: number };
      expect(row.n).toBe(1);
    } finally {
      verify.close();
    }

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain(`Restored ${projectId} into Grove Work`);

    log.mockRestore();
  });

  it('errors when the project ref is unknown', async () => {
    setupProject();
    await expect(run(['project', 'proj_deadbeefdeadbeefdeadbeefdeadbeef']))
      .rejects.toThrow(/Project not found/);
  });

  it('errors when the snapshot path does not exist', async () => {
    await expect(run(['restore', path.join(tmpDir, 'missing.sql')]))
      .rejects.toThrow(/Snapshot not found/);
  });

  it('errors when restoring a snapshot for a project not registered locally', async () => {
    const { projectId, slug } = setupProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['project', projectId]);
    log.mockRestore();

    const backupDir = path.join(backupsDir, slug);
    const sqlFile = fs.readdirSync(backupDir).find((f) => f.endsWith('.sql'))!;
    const snapshotPath = path.join(backupDir, sqlFile);

    // Forge a fresh Myco home with no projects registered. Snapshot header
    // still refers to the original project id, so restore can't locate it.
    const otherHome = path.join(tmpDir, 'other-home');
    fs.mkdirSync(otherHome, { recursive: true });
    process.env.MYCO_HOME = otherHome;

    await expect(run(['restore', snapshotPath]))
      .rejects.toThrow(/is not registered locally/);
  });

  it('prints help when no subcommand is given', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    await run([]);
    expect(out.mock.calls.flat().join('')).toContain('Usage: myco backup');
    out.mockRestore();
  });
});
