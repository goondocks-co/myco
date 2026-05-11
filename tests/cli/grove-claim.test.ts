import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  loadGroveRecord,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  setDevServiceMode,
} from '@myco/grove/paths.js';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/grove.js';

function seedGroveDb(
  groveId: string,
  mycoHome: string,
  projectId: string,
): void {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code', 'Claude Code', 'built-in', 1, now);
    db.prepare(
      `INSERT INTO sessions (
         id, project_id, agent, started_at, status, created_at, machine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess-prod-1', projectId, 'claude-code', now, 'idle', now, 'local');
  } finally {
    db.close();
  }
}

function countSessions(groveId: string, mycoHome: string): number {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function deleteSession(groveId: string, mycoHome: string, sessionId: string): void {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  const db = openDatabase(dbPath);
  try {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  } finally {
    db.close();
  }
}

let home: string;
let backupsDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-claim-'));
  backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-claim-backups-'));
  process.env.MYCO_HOME = home;
  process.env.MYCO_BACKUPS_DIR = backupsDir;
  setDevServiceMode(true);
  clearGroveRegistryCaches();
});

afterEach(() => {
  delete process.env.MYCO_HOME;
  delete process.env.MYCO_BACKUPS_DIR;
  setDevServiceMode(false);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(backupsDir, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

describe('myco grove claim/release', () => {
  it('claims and releases a Grove, restoring pre-claim state', async () => {
    const grove = createGrove('Prod', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-prod');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Prod App',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['claim', grove.slug]);
    log.mockClear();

    const claimedGrove = loadGroveRecord(grove.id, home);
    expect(claimedGrove?.served_by).toBe('service-dev');

    const claimDir = path.join(backupsDir, 'claims', grove.slug);
    const activeClaims = fs.readdirSync(claimDir).filter((n) => n !== 'archive');
    expect(activeClaims.length).toBe(1);
    expect(fs.existsSync(path.join(claimDir, activeClaims[0], 'claim.json'))).toBe(true);
    expect(fs.existsSync(path.join(claimDir, activeClaims[0], 'grove-claim.sql'))).toBe(true);

    deleteSession(grove.id, home, 'sess-prod-1');
    expect(countSessions(grove.id, home)).toBe(0);

    await run(['release', grove.slug]);

    const releasedGrove = loadGroveRecord(grove.id, home);
    expect(releasedGrove?.served_by).toBe('service');
    expect(countSessions(grove.id, home)).toBe(1);

    const remainingActive = fs.readdirSync(claimDir).filter((n) => n !== 'archive');
    expect(remainingActive.length).toBe(0);
    const archives = fs.readdirSync(path.join(claimDir, 'archive'));
    expect(archives.length).toBe(1);

    log.mockRestore();
  });

  it('refuses to claim when a claim is already in place', async () => {
    const grove = createGrove('Prod', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-twice');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Twice',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['claim', grove.slug]);

    await expect(run(['claim', grove.slug])).rejects.toThrow(/served by service-dev/);

    log.mockRestore();
  });

  it('refuses to release without a claim manifest', async () => {
    const grove = createGrove('Empty', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-empty');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Empty',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    await expect(run(['release', grove.slug])).rejects.toThrow(/No active claim manifest/);
  });

  it('refuses to claim a Grove already served by service-dev', async () => {
    const grove = createGrove('Already', home, { servedBy: 'service-dev' });
    expect(grove.served_by).toBe('service-dev');

    await expect(run(['claim', grove.slug])).rejects.toThrow(/only Groves served by 'service'/);
  });

  it('set-served-by refuses without --force', async () => {
    const grove = createGrove('Recover', home);

    await expect(run(['set-served-by', grove.slug, 'service-dev'])).rejects.toThrow(
      /recovery command/,
    );

    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');
  });

  it('set-served-by with --force flips served_by', async () => {
    const grove = createGrove('Recover2', home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['set-served-by', grove.slug, 'service-dev', '--force']);
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service-dev');

    await run(['set-served-by', grove.slug, 'service', '--force']);
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');

    log.mockRestore();
  });

  it('set-served-by rejects an unknown variant', async () => {
    const grove = createGrove('BadVariant', home);

    await expect(
      run(['set-served-by', grove.slug, 'service-blue', '--force']),
    ).rejects.toThrow(/Invalid served_by variant/);
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');
  });

  it('refuses to claim or release outside dev service mode', async () => {
    const grove = createGrove('Prod', home);
    setDevServiceMode(false);

    await expect(run(['claim', grove.slug])).rejects.toThrow(/dev daemon/);
    await expect(run(['release', grove.slug])).rejects.toThrow(/dev daemon/);
  });

  it('recovers from a flipped-but-incomplete claim by running release', async () => {
    const grove = createGrove('Recovery', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-recovery');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Recovery',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['claim', grove.slug]);

    await expect(run(['claim', grove.slug])).rejects.toThrow();

    deleteSession(grove.id, home, 'sess-prod-1');
    await run(['release', grove.slug]);

    expect(countSessions(grove.id, home)).toBe(1);
    expect(loadGroveRecord(grove.id, home)?.served_by).toBe('service');

    log.mockRestore();
  });
});
