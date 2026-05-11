import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';
import { createProjectId } from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveProjectManifestPath,
  resolveProjectVaultDir,
  setDevServiceMode,
} from '@myco/grove/paths.js';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/grove.js';

function writeProjectManifest(
  projectRoot: string,
  projectId: string,
  projectName: string,
  grove: { id: string; slug: string; name: string },
): void {
  const vault = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(
    resolveProjectManifestPath(vault),
    stringifyToml({
      project: { id: projectId, name: projectName },
      grove: { id: grove.id, slug: grove.slug, name: grove.name },
    }),
    'utf-8',
  );
}

function readManifestGrove(projectRoot: string): { id?: string; slug?: string; name?: string } {
  const text = fs.readFileSync(
    resolveProjectManifestPath(resolveProjectVaultDir(projectRoot)),
    'utf-8',
  );
  const out: { id?: string; slug?: string; name?: string } = {};
  let inGrove = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inGrove = trimmed === '[grove]';
      continue;
    }
    if (!inGrove) continue;
    const m = trimmed.match(/^(id|slug|name)\s*=\s*"([^"]+)"$/);
    if (m) out[m[1] as 'id' | 'slug' | 'name'] = m[2];
  }
  return out;
}

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

  it('snapshot preserves source DB contents and copies non-SQLite sidecars byte-for-byte', async () => {
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
    const vectorsPath = path.join(
      path.dirname(resolveGroveDbPath(grove.id, home)),
      'vectors.db',
    );
    fs.writeFileSync(vectorsPath, 'PRETEND-VECTORS-DATA\nwith newlines\n');

    const sourceDbPath = resolveGroveDbPath(grove.id, home);
    const sourceSessions = (() => {
      const db = openDatabase(sourceDbPath);
      try {
        return db.prepare(`SELECT id, project_id, agent, status FROM sessions ORDER BY id`).all();
      } finally {
        db.close();
      }
    })();

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

    // SQLite snapshot is via VACUUM INTO: same row contents, possibly
    // different bytes. Assert semantic equivalence on the data.
    const snapshotSessions = (() => {
      const db = openDatabase(snapshotDb);
      try {
        return db.prepare(`SELECT id, project_id, agent, status FROM sessions ORDER BY id`).all();
      } finally {
        db.close();
      }
    })();
    expect(snapshotSessions).toEqual(sourceSessions);

    // The vectors sidecar fixture is not a SQLite DB, so it falls back
    // to a raw byte copy and must match exactly.
    const sourceVectorsBytes = fs.readFileSync(vectorsPath);
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

  it('rejects a manifest with an unsupported schema version', async () => {
    const grove = createGrove('UnknownSchema', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'project-unknown-schema');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'UnknownSchema',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);

    const claimDir = path.join(backupsDir, 'claims', grove.slug, '67890');
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(
      path.join(claimDir, 'claim.json'),
      JSON.stringify({
        schema: 999,
        grove_id: grove.id,
        grove_slug: grove.slug,
        grove_name: grove.name,
        original_served_by: 'service',
        snapshot_db_path: path.join(claimDir, 'grove-claim.db'),
        claim_root: claimDir,
        claimed_at: 67890,
        owner_op: 'unknown-schema',
        claim_phase: 'flipped',
      }),
    );
    fs.writeFileSync(path.join(claimDir, 'grove-claim.db'), 'PRETEND-DB');

    await expect(run(['release', grove.slug])).rejects.toThrow(/Unsupported claim manifest schema/);
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

  it('release rolls back a Grove created and a project moved during the claim window', async () => {
    const sourceGrove = createGrove('TransactionalSource', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'tx-source-project');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(sourceGrove.id, {
      projectId,
      projectName: 'TX Source Project',
      projectRoot,
    }, home);
    seedGroveDb(sourceGrove.id, home, projectId);
    writeProjectManifest(projectRoot, projectId, 'TX Source Project', sourceGrove);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await run(['claim', sourceGrove.slug]);

    // Create a new Grove during the claim window and move the project into it.
    const newGrove = createGrove('CreatedDuringClaim', home);
    moveProjectBetweenGroves(sourceGrove.id, newGrove.id, projectId, home, {
      snapshotsRoot: path.join(backupsDir, 'move-snapshots'),
    });

    expect(listGroves(home).map((g) => g.id).sort())
      .toEqual([sourceGrove.id, newGrove.id].sort());
    expect(listRegisteredProjects(sourceGrove.id, home).length).toBe(0);
    expect(listRegisteredProjects(newGrove.id, home).length).toBe(1);
    expect(readManifestGrove(projectRoot).id).toBe(newGrove.id);

    await run(['release', sourceGrove.slug]);

    expect(listGroves(home).map((g) => g.id)).toEqual([sourceGrove.id]);
    expect(listRegisteredProjects(sourceGrove.id, home).map((p) => p.project_id))
      .toEqual([projectId]);
    expect(readManifestGrove(projectRoot).id).toBe(sourceGrove.id);
    expect(loadGroveRecord(sourceGrove.id, home)?.served_by).toBe('service');
    expect(countSessions(sourceGrove.id, home)).toBe(1);

    // Regression: registry snapshot must strip transient pause blocks so
    // restore doesn't re-introduce claim-owned pauses (which release's
    // resume can't clear due to owner_op mismatch).
    const projectsTomlPath = path.join(
      home,
      'groves',
      sourceGrove.id,
      'registry',
      'projects.toml',
    );
    const projectsTomlContent = fs.readFileSync(projectsTomlPath, 'utf-8');
    expect(projectsTomlContent).not.toContain('.paused]');

    log.mockRestore();
    errSpy.mockRestore();
  });

  it('release restores a project manifest that was edited during the claim window', async () => {
    const grove = createGrove('ManifestEditTest', home);
    const projectId = createProjectId();
    const projectRoot = path.join(home, 'manifest-edit-project');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Manifest Edit',
      projectRoot,
    }, home);
    seedGroveDb(grove.id, home, projectId);
    writeProjectManifest(projectRoot, projectId, 'Manifest Edit', grove);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['claim', grove.slug]);

    const manifestPath = resolveProjectManifestPath(resolveProjectVaultDir(projectRoot));
    fs.writeFileSync(
      manifestPath,
      stringifyToml({
        project: { id: projectId, name: 'Manifest Edit' },
        grove: { id: grove.id, slug: grove.slug, name: 'RENAMED-DURING-CLAIM' },
      }),
      'utf-8',
    );

    expect(readManifestGrove(projectRoot).name).toBe('RENAMED-DURING-CLAIM');

    await run(['release', grove.slug]);

    expect(readManifestGrove(projectRoot).name).toBe(grove.name);

    log.mockRestore();
  });
});
