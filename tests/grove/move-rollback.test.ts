import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  isProjectPaused,
  listRegisteredProjects,
  pauseProject,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';

let tmpDir: string;
let mycoHome: string;
let projectRoot: string;
let vaultDir: string;
let snapshotsRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-move-rollback-'));
  mycoHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  snapshotsRoot = path.join(tmpDir, 'snapshots');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  vaultDir = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'machine_id'), 'test-user_deadbeef', 'utf-8');
  clearGroveRegistryCaches();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function withGroveDb<T>(groveId: string, fn: (db: Database) => T): T {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureGroveDb(groveId: string): void {
  withGroveDb(groveId, (db) => createSchema(db));
}

function seedAgent(groveId: string): void {
  withGroveDb(groveId, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES ('claude-code', 'Claude Code', 'built-in', 1, 100)`,
    ).run();
  });
}

function seedProjectRows(groveId: string, projectId: string): void {
  withGroveDb(groveId, (db) => {
    db.prepare(
      `INSERT INTO sessions (id, agent, project_root, project_id, started_at, created_at, machine_id)
       VALUES (?, 'claude-code', ?, ?, 200, 200, 'test-machine')`,
    ).run(`sess-${projectId}-1`, projectRoot, projectId);
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, session_id, observation_type, content, created_at)
       VALUES (?, ?, 'claude-code', ?, 'gotcha', 'spore body', 220)`,
    ).run(`spore-${projectId}-1`, projectId, `sess-${projectId}-1`);
  });
}

function countRows(groveId: string, table: string, projectId: string): number {
  return withGroveDb(groveId, (db) => {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
    ).get(projectId) as { n: number };
    return row.n;
  });
}

function readMarkers(): Array<Record<string, unknown>> {
  const migrationDir = path.join(vaultDir, 'migration');
  if (!fs.existsSync(migrationDir)) return [];
  return fs.readdirSync(migrationDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(migrationDir, f), 'utf-8')));
}

describe('move failure rollback and pause release', () => {
  it('verify failure: wipes the target, marks the move failed, releases the pause, and a retry starts fresh', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    // Inject a count mismatch: a marker claiming the restore already ran
    // while the target holds nothing. Verify must fail and roll back.
    const moveOpId = `grove-move-${projectId}-injected`;
    const migrationDir = path.join(vaultDir, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    const snapshotPath = path.join(migrationDir, 'fake-snapshot.sql');
    fs.writeFileSync(snapshotPath, '-- Myco backup: machine_id=test, created_at=1\n', 'utf-8');
    pauseProject(source.id, projectId, 'grove-move', moveOpId, mycoHome);
    fs.writeFileSync(
      path.join(migrationDir, `${moveOpId}.json`),
      JSON.stringify({
        move_op_id: moveOpId,
        from_grove_id: source.id,
        to_grove_id: target.id,
        project_id: projectId,
        project_name: 'Demo',
        project_root: projectRoot,
        started_at: new Date().toISOString(),
        phase: 'restored',
        snapshot_path: snapshotPath,
      }),
    );

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/move verification failed/);

    // Target holds nothing for the project; marker recorded the failure.
    expect(countRows(target.id, 'sessions', projectId)).toBe(0);
    const failedMarker = readMarkers().find((m) => m.move_op_id === moveOpId);
    expect(failedMarker?.phase).toBe('failed');
    expect(String(failedMarker?.error)).toContain('move verification failed');

    // The pause was released — source writes are no longer refused.
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);

    // Source data untouched by the failed attempt.
    expect(countRows(source.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'spores', projectId)).toBe(1);

    // A retry does NOT resume the failed op: it starts a fresh move op
    // and completes.
    const result = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });
    expect(result.table_counts.sessions).toBe(1);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);

    const markers = readMarkers();
    const completed = markers.find((m) => m.phase === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.move_op_id).not.toBe(moveOpId);
  });

  it('releases the pause when the move throws before the snapshot completes', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    // Snapshot failure injection: the snapshots root is a FILE, so
    // creating the snapshot directory under it throws.
    const blockedRoot = path.join(tmpDir, 'blocked-snapshots');
    fs.writeFileSync(blockedRoot, 'not a directory', 'utf-8');

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
        snapshotsRoot: blockedRoot,
      }),
    ).toThrow();

    // The failure left no pause behind and recorded a failed marker.
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);
    expect(readMarkers().map((m) => m.phase)).toEqual(['failed']);

    // With the obstruction removed, the next call succeeds end-to-end.
    const result = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });
    expect(result.table_counts.sessions).toBe(1);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
  });

  it('TEXT-FK pollution fails verify: dangling copied references cannot commit', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    const otherProjectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);
    seedProjectRows(source.id, otherProjectId);

    // Pollute a TEXT foreign key: the moved project's spore points at the
    // OTHER project's session. Valid in the source (the session exists),
    // but the copy only carries the moved project's rows — in the target
    // the reference dangles. Counts match and the integer-FK orphan check
    // passes; only the verify-phase foreign_key_check can see it.
    withGroveDb(source.id, (db) => {
      db.prepare(`UPDATE spores SET session_id = ? WHERE id = ?`)
        .run(`sess-${otherProjectId}-1`, `spore-${projectId}-1`);
    });

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/foreign key violation/);

    // Failure rollback: target wiped, marker failed, pause released,
    // source untouched.
    expect(countRows(target.id, 'spores', projectId)).toBe(0);
    expect(countRows(target.id, 'sessions', projectId)).toBe(0);
    expect(readMarkers().map((m) => m.phase)).toEqual(['failed']);
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);
    expect(countRows(source.id, 'spores', projectId)).toBe(1);

    // Repair the polluted row, retry: fresh move op succeeds.
    withGroveDb(source.id, (db) => {
      db.prepare(`UPDATE spores SET session_id = ? WHERE id = ?`)
        .run(`sess-${projectId}-1`, `spore-${projectId}-1`);
    });
    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });
    expect(countRows(target.id, 'spores', projectId)).toBe(1);
    expect(countRows(source.id, 'spores', projectId)).toBe(0);
  });

  it('count errors other than a missing table fail the move and release the pause', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    // Break log_entries on BOTH sides the same way: project_id gone, so
    // the per-table count fails with "no such column". The old swallow-
    // to-zero behavior would verify this as 0 == 0; it must throw.
    for (const groveId of [source.id, target.id]) {
      withGroveDb(groveId, (db) => {
        db.run('DROP INDEX idx_log_entries_project_id');
        db.run('ALTER TABLE log_entries DROP COLUMN project_id');
      });
    }

    // Enter at the verify phase so the failure is countProjectRows', not
    // the copy's (the copy guards the same error class separately).
    const moveOpId = `grove-move-${projectId}-count-injected`;
    const migrationDir = path.join(vaultDir, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    const snapshotPath = path.join(migrationDir, 'fake-snapshot.sql');
    fs.writeFileSync(snapshotPath, '-- Myco backup: machine_id=test, created_at=1\n', 'utf-8');
    pauseProject(source.id, projectId, 'grove-move', moveOpId, mycoHome);
    fs.writeFileSync(
      path.join(migrationDir, `${moveOpId}.json`),
      JSON.stringify({
        move_op_id: moveOpId,
        from_grove_id: source.id,
        to_grove_id: target.id,
        project_id: projectId,
        project_name: 'Demo',
        project_root: projectRoot,
        started_at: new Date().toISOString(),
        phase: 'restored',
        snapshot_path: snapshotPath,
      }),
    );

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/failed to count log_entries rows/);

    expect(readMarkers().map((m) => m.phase)).toEqual(['failed']);
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);
    expect(countRows(source.id, 'sessions', projectId)).toBe(1);
  });

  it('cleanup failure surfaces loudly, deletes nothing, and the move resumes once unblocked', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    // Injected source-delete failure: cleanup must throw, not swallow.
    withGroveDb(source.id, (db) => {
      db.run(
        `CREATE TRIGGER block_spore_delete BEFORE DELETE ON spores
         BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`,
      );
    });

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/injected cleanup failure/);

    // Past the commit phase the target owns the data: the marker stays
    // resumable (NOT failed), the target keeps its rows, and the
    // source-delete transaction rolled back whole.
    expect(readMarkers().map((m) => m.phase)).toEqual(['committed']);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'spores', projectId)).toBe(1);
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);

    // Unblock and resume: cleanup completes the same move op.
    withGroveDb(source.id, (db) => db.run('DROP TRIGGER block_spore_delete'));
    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });

    expect(readMarkers().map((m) => m.phase)).toEqual(['completed']);
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);
    expect(countRows(source.id, 'spores', projectId)).toBe(0);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(listRegisteredProjects(target.id, mycoHome).map((p) => p.project_id))
      .toContain(projectId);
  });
});
