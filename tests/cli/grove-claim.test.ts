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
    expect(fs.existsSync(path.join(claimDir, activeClaims[0], 'grove-claim.db'))).toBe(true);

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

  it('snapshot is a literal byte-for-byte file copy of the source DB', async () => {
    const grove = createGrove('FileCopy', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-filecopy');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'FileCopy',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);
    // Also drop a vectors.db sidecar so we can prove it round-trips too.
    const vectorsPath = path.join(
      path.dirname(resolveGroveDbPath(grove.id, home)),
      'vectors.db',
    );
    fs.writeFileSync(vectorsPath, 'PRETEND-VECTORS-DATA\nwith newlines\n');

    const sourceDbPath = resolveGroveDbPath(grove.id, home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['claim', grove.slug]);
    log.mockRestore();

    const claimDir = path.join(backupsDir, 'claims', grove.slug);
    const claimRoot = path.join(
      claimDir,
      fs.readdirSync(claimDir).find((n) => n !== 'archive')!,
    );
    const snapshotDb = path.join(claimRoot, 'grove-claim.db');
    const snapshotVectors = path.join(claimRoot, 'vectors-claim.db');

    expect(fs.existsSync(snapshotDb)).toBe(true);
    expect(fs.existsSync(snapshotVectors)).toBe(true);
    // Compare to source AFTER claim — claim's WAL checkpoint and the
    // copy happen atomically (claim takes a pause first), so the bytes
    // on disk at the moment of copy are what we measure here.
    const sourceDbBytes = fs.readFileSync(sourceDbPath);
    const sourceVectorsBytes = fs.readFileSync(vectorsPath);
    expect(fs.readFileSync(snapshotDb).equals(sourceDbBytes)).toBe(true);
    expect(fs.readFileSync(snapshotVectors).equals(sourceVectorsBytes)).toBe(true);
  });

  it('preserves multi-line content across claim/release round-trip', async () => {
    const grove = createGrove('Multiline', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-multiline');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Multiline',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    // Insert a spore with a multi-line body that the previous line-based
    // restore parser would have silently truncated.
    const dbPath = resolveGroveDbPath(grove.id, home);
    const body = `## A multi-line body\n\n- with bullets\n- and a 'quote'\n\nEnd.`;
    const db = openDatabase(dbPath);
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO spores (id, project_id, session_id, agent_id, observation_type, content, created_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('spore-multi', projectId, 'sess-prod-1', 'claude-code', 'gotcha', body, now, 'local');
    } finally {
      db.close();
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['claim', grove.slug]);

    // Mutate the live DB after claim — multi-line body should be restored
    // exactly on release.
    {
      const live = openDatabase(dbPath);
      try {
        live.prepare(`UPDATE spores SET content = ? WHERE id = ?`).run('mutated', 'spore-multi');
        live.prepare(`DELETE FROM spores WHERE id = ?`).run('spore-multi');
      } finally {
        live.close();
      }
    }

    await run(['release', grove.slug]);
    log.mockRestore();

    const after = openDatabase(dbPath);
    try {
      const row = after.prepare(`SELECT content FROM spores WHERE id = ?`).get('spore-multi') as
        | { content: string }
        | undefined;
      expect(row?.content).toBe(body);
    } finally {
      after.close();
    }
  });

  it('rejects a legacy schema-1 manifest with a clear error', async () => {
    const grove = createGrove('LegacyManifest', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-legacy');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Legacy',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    // Hand-write a v1 manifest.
    const claimDir = path.join(backupsDir, 'claims', grove.slug, '12345');
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(
      path.join(claimDir, 'claim.json'),
      JSON.stringify({
        schema: 1,
        grove_id: grove.id,
        grove_slug: grove.slug,
        grove_name: grove.name,
        original_served_by: 'service',
        snapshot_path: path.join(claimDir, 'grove-claim.sql'),
        claim_root: claimDir,
        claimed_at: 12345,
        owner_op: 'legacy',
        phase: 'flipped',
      }),
    );
    fs.writeFileSync(path.join(claimDir, 'grove-claim.sql'), '-- legacy\n');

    await expect(run(['release', grove.slug])).rejects.toThrow(/Legacy claim manifest/);
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
