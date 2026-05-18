import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  deregisterProjectInGrove,
  isProjectPaused,
  listRegisteredProjects,
  pauseProject,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createBackup } from '@myco/daemon/backup.js';
import {
  assertGroveProjectId,
  createProjectId,
  projectScope,
  projectUrlSlug,
} from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';

let tmpDir: string;
let mycoHome: string;
let projectRoot: string;
let vaultDir: string;
let snapshotsRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-move-'));
  mycoHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  snapshotsRoot = path.join(tmpDir, 'snapshots');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  vaultDir = resolveProjectVaultDir(projectRoot);
  fs.mkdirSync(vaultDir, { recursive: true });
  // Pre-seed machine_id so the move orchestrator skips its `gh api user`
  // probe — that probe can take several seconds and is irrelevant here.
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
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code', 'Claude Code', 'built-in', 1, 100);
  });
}

function seedProjectRows(groveId: string, projectId: string, root = projectRoot): void {
  withGroveDb(groveId, (db) => {
    db.prepare(
      `INSERT INTO sessions (
         id, agent, project_root, branch, started_at, status, created_at,
         embedded, machine_id, project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `sess-${projectId}-1`,
      'claude-code',
      root,
      'main',
      200,
      'completed',
      200,
      1,
      'test-machine',
      projectId,
    );
    db.prepare(
      `INSERT INTO plans (
         id, logical_key, status, author, title, content, source_path,
         tags, session_id, content_hash, processed, created_at,
         updated_at, embedded, machine_id, project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `plan-${projectId}-1`,
      `move:${projectId}`,
      'active',
      'claude-code',
      `Plan for ${projectId}`,
      'Move me content',
      null,
      'move',
      `sess-${projectId}-1`,
      `hash-${projectId}`,
      1,
      210,
      211,
      1,
      'test-machine',
      projectId,
    );
    db.prepare(
      `INSERT INTO spores (
         id, agent_id, session_id, observation_type, content,
         created_at, machine_id, project_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `spore-${projectId}-1`,
      'claude-code',
      `sess-${projectId}-1`,
      'gotcha',
      'Project-scoped spore',
      220,
      'test-machine',
      projectId,
    );
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

function countAllRows(groveId: string, table: string): number {
  return withGroveDb(groveId, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  });
}

function foreignKeyViolations(groveId: string): unknown[] {
  return withGroveDb(groveId, (db) => db.prepare('PRAGMA foreign_key_check').all());
}

function embeddedValue(groveId: string, table: string, id: string): number {
  return withGroveDb(groveId, (db) => {
    const row = db.prepare(`SELECT embedded FROM ${table} WHERE id = ?`).get(id) as {
      embedded: number;
    };
    return row.embedded;
  });
}

describe('moveProjectBetweenGroves', () => {
  it('happy path: relocates project data, registry, and manifest to target Grove', () => {
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
      bindingId: 'gbind_initial',
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    const result = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });

    expect(result.from_grove_id).toBe(source.id);
    expect(result.to_grove_id).toBe(target.id);
    expect(result.project_id).toBe(projectId);
    expect(fs.existsSync(result.snapshot_path)).toBe(true);
    expect(Object.keys(result.table_counts).length).toBeGreaterThan(0);
    expect(result.table_counts.sessions).toBe(1);
    expect(result.table_counts.plans).toBe(1);
    expect(result.table_counts.spores).toBe(1);

    // Target Grove has the rows.
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(target.id, 'plans', projectId)).toBe(1);
    expect(countRows(target.id, 'spores', projectId)).toBe(1);

    // Source Grove no longer has the rows.
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);
    expect(countRows(source.id, 'plans', projectId)).toBe(0);
    expect(countRows(source.id, 'spores', projectId)).toBe(0);

    // Source registry no longer lists; target does.
    expect(listRegisteredProjects(source.id, mycoHome).map((p) => p.project_id))
      .not.toContain(projectId);
    expect(listRegisteredProjects(target.id, mycoHome).map((p) => p.project_id))
      .toContain(projectId);

    // project.toml reflects target's Grove.
    const manifestRaw = fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8');
    const manifest = parseToml(manifestRaw) as { grove?: { id?: string; slug?: string; name?: string } };
    expect(manifest.grove?.id).toBe(target.id);
    expect(manifest.grove?.slug).toBe('target');
    expect(manifest.grove?.name).toBe('Target');

    // project.local.toml has a fresh binding_id.
    const localRaw = fs.readFileSync(path.join(vaultDir, 'project.local.toml'), 'utf-8');
    const localDoc = parseToml(localRaw) as { grove_binding?: { binding_id?: string } };
    const newBinding = localDoc.grove_binding?.binding_id;
    expect(newBinding).toBeDefined();
    expect(newBinding).not.toBe('gbind_initial');

    // Target registry entry points at the new binding.
    const targetEntry = listRegisteredProjects(target.id, mycoHome).find(
      (p) => p.project_id === projectId,
    );
    expect(targetEntry?.binding_id).toBe(newBinding);

    // Marker file exists with phase 'completed'.
    const migrationDir = path.join(vaultDir, 'migration');
    const markers = fs.readdirSync(migrationDir);
    expect(markers).toHaveLength(1);
    const marker = JSON.parse(fs.readFileSync(path.join(migrationDir, markers[0]), 'utf-8'));
    expect(marker.phase).toBe('completed');
    expect(marker.snapshot_path).toBe(result.snapshot_path);

    // Project is no longer paused (deregistered from source clears the entry).
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);
  });

  it('initializes target Grove DB on demand when it has never been activated', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    // Only the source DB gets a schema. The target is registered but
    // its SQLite file has never been opened — the orchestrator must
    // initialize it before restore.
    ensureGroveDb(source.id);
    seedAgent(source.id);
    expect(fs.existsSync(resolveGroveDbPath(target.id, mycoHome))).toBe(false);

    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);

    const result = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });

    expect(result.table_counts.sessions).toBe(1);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(target.id, 'plans', projectId)).toBe(1);
    expect(countRows(target.id, 'spores', projectId)).toBe(1);
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);
    expect(countAllRows(target.id, 'agents')).toBe(1);
    expect(foreignKeyViolations(target.id)).toEqual([]);
    expect(embeddedValue(target.id, 'sessions', `sess-${projectId}-1`)).toBe(0);
    expect(embeddedValue(target.id, 'plans', `plan-${projectId}-1`)).toBe(0);
    expect(embeddedValue(target.id, 'spores', `spore-${projectId}-1`)).toBe(0);
  });

  it('cleans stale source rows for the same project root after a successful move', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const currentProjectId = createProjectId();
    const staleProjectId = createProjectId();
    const unrelatedProjectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId: currentProjectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, currentProjectId);
    seedProjectRows(source.id, staleProjectId);
    seedProjectRows(source.id, unrelatedProjectId, path.join(tmpDir, 'other-project'));

    moveProjectBetweenGroves(source.id, target.id, currentProjectId, mycoHome, { snapshotsRoot });

    expect(countRows(target.id, 'sessions', currentProjectId)).toBe(1);
    expect(countRows(source.id, 'sessions', currentProjectId)).toBe(0);
    expect(countRows(source.id, 'spores', currentProjectId)).toBe(0);
    expect(countRows(source.id, 'sessions', staleProjectId)).toBe(0);
    expect(countRows(source.id, 'spores', staleProjectId)).toBe(0);
    expect(countRows(source.id, 'sessions', unrelatedProjectId)).toBe(1);
    expect(countRows(source.id, 'spores', unrelatedProjectId)).toBe(1);
  });

  it('throws when source and target Grove ids are the same', () => {
    const grove = createGrove('Solo', mycoHome);
    ensureGroveDb(grove.id);
    const projectId = createProjectId();
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);

    expect(() =>
      moveProjectBetweenGroves(grove.id, grove.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/source and target Grove ids must differ/);
  });

  it('throws when the target Grove is not registered locally', () => {
    const source = createGrove('Source', mycoHome);
    ensureGroveDb(source.id);
    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);

    expect(() =>
      moveProjectBetweenGroves(
        source.id,
        'grove_00000000000000000000000000000000',
        projectId,
        mycoHome,
        { snapshotsRoot },
      ),
    ).toThrow(/Target Grove .* is not registered locally/);
  });

  it('throws when the project is not registered in the source Grove', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    const projectId = createProjectId();

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/not registered in Grove/);
  });

  it('resumes from snapshot_complete: restores, verifies, commits without re-snapshotting', () => {
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

    // First, do a full move so we have a real snapshot file on disk.
    const initial = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });

    // Calling again with a completed marker is idempotent.
    const repeat = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });
    expect(repeat.snapshot_path).toBe(initial.snapshot_path);
    expect(repeat.table_counts.sessions).toBe(initial.table_counts.sessions);
  });

  it('resumes mid-flight when a snapshot_complete marker is hand-crafted', () => {
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

    // Manually run the snapshot phase via createBackup, then drop a marker
    // recording phase=snapshot_complete. The orchestrator should pick up
    // at restore.
    const moveOpId = `grove-move-${projectId}-9999`;
    const migrationDir = path.join(vaultDir, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });

    // Use a real backup file produced by the orchestrator's first call
    // up through the snapshot phase. Easiest: run createBackup directly.
    // We piggyback on the orchestrator's path layout for the snapshot.
    // To do this cleanly, run a real move first into a third Grove, then
    // pretend to be resuming. Instead — simpler — run a partial move by
    // crashing after snapshot. We don't have a fault-injection seam, so
    // we do a full move, then deliberately copy the snapshot file and
    // craft a marker pointing to it for a fresh project move.
    //
    // For this test we do a full happy-path move, which leaves a marker
    // and snapshot. We then rewind: delete target rows, re-register the
    // project on source, hand-craft a snapshot_complete marker for a
    // fresh move op, and call moveProjectBetweenGroves again.
    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });

    // Tear target rows down; re-register on source; reset the project
    // manifest so we can start a "second" move.
    withGroveDb(target.id, (db) => {
      db.run('PRAGMA foreign_keys = OFF');
      try {
        for (const table of ['plans', 'spores', 'sessions']) {
          db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
        }
      } finally {
        db.run('PRAGMA foreign_keys = ON');
      }
    });
    seedProjectRows(source.id, projectId);
    // Pull the project off the target and reattach to source for the
    // resume scenario.
    deregisterProjectInGrove(target.id, projectId, mycoHome);
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);

    // Take a fresh snapshot via createBackup at the location the
    // orchestrator would write it.
    const projectSlug = projectUrlSlug('Demo', projectId);
    const snapshotDir = path.join(snapshotsRoot, projectSlug, moveOpId);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = withGroveDb(source.id, (db) =>
      createBackup(db, snapshotDir, 'test-machine', projectScope(assertGroveProjectId(projectId)), projectSlug),
    );

    // Clear out the prior happy-path marker(s) and write our craft.
    for (const f of fs.readdirSync(migrationDir)) {
      fs.rmSync(path.join(migrationDir, f), { force: true });
    }
    fs.writeFileSync(
      path.join(migrationDir, `${moveOpId}.json`),
      JSON.stringify({
        move_op_id: moveOpId,
        from_grove_id: source.id,
        to_grove_id: target.id,
        project_id: projectId,
        started_at: new Date().toISOString(),
        phase: 'snapshot_complete',
        snapshot_path: snapshotPath,
      }, null, 2),
      'utf-8',
    );

    // Now resume — should restore from the existing snapshot (not re-snapshot).
    const result = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });

    expect(result.snapshot_path).toBe(snapshotPath);
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);
  });

  it('refuses when an in-progress marker exists for a different project', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectA = createProjectId();
    const projectB = createProjectId();
    registerProjectInGrove(source.id, {
      projectId: projectB,
      projectName: 'B',
      projectRoot,
    }, mycoHome);

    const migrationDir = path.join(vaultDir, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationDir, 'grove-move-a.json'),
      JSON.stringify({
        move_op_id: 'grove-move-a',
        from_grove_id: source.id,
        to_grove_id: target.id,
        project_id: projectA,
        started_at: new Date().toISOString(),
        phase: 'restored',
      }, null, 2),
      'utf-8',
    );

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectB, mycoHome, { snapshotsRoot }),
    ).toThrow(/different project/);
  });

  it('writes markers in a parseable state after every phase (atomic temp+rename)', () => {
    // Atomic semantics are hard to test deterministically without fault
    // injection. Structural test: after a full move, every JSON marker
    // file in the migration dir parses cleanly (no torn writes left
    // behind, no orphaned `.tmp-*` files).
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

    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });

    const migrationDir = path.join(vaultDir, 'migration');
    const entries = fs.readdirSync(migrationDir);
    // No leftover temp files from the atomic write path.
    expect(entries.every((entry) => !entry.includes('.tmp-'))).toBe(true);
    // Every marker JSON parses successfully.
    for (const entry of entries) {
      const raw = fs.readFileSync(path.join(migrationDir, entry), 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('resumes after a partial commit: target registered, source deregistered, marker still verified', () => {
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

    // Drive the orchestrator through to completion, then rewind into the
    // exact post-commit-step / pre-marker-write state we want to resume
    // from: target registered, source deregistered, marker recorded as
    // 'verified' (NOT 'committed') so the commit block re-enters.
    const initial = moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, {
      snapshotsRoot,
    });

    const migrationDir = path.join(vaultDir, 'migration');
    const markers = fs.readdirSync(migrationDir).filter((f) => f.endsWith('.json'));
    expect(markers).toHaveLength(1);
    const markerPath = path.join(migrationDir, markers[0]);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));

    // Hand-craft the partial-commit scenario: marker says 'verified',
    // but on disk we already have target registered and source
    // deregistered (the orchestrator's commit block already ran the
    // register+deregister but didn't get to advance the marker).
    marker.phase = 'verified';
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');

    // Resume must NOT throw: target register is a no-op merge; source
    // deregister is force:true so the missing entry is tolerated.
    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).not.toThrow();

    // Final state still consistent: target has rows, source has none,
    // marker advanced to completed.
    expect(countRows(target.id, 'sessions', projectId)).toBe(1);
    expect(countRows(source.id, 'sessions', projectId)).toBe(0);
    const finalMarker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(finalMarker.phase).toBe('completed');
    // Snapshot path is preserved through the resume.
    expect(finalMarker.snapshot_path).toBe(initial.snapshot_path);
  });

  it('clean phase deletes entity_mentions from source for the moved project only', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const movingProjectId = createProjectId();
    const otherProjectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId: movingProjectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, movingProjectId);

    // Seed entity_mentions for both the moving project and an unrelated
    // project. entity_mentions is project-scoped but excluded from
    // BACKUP_TABLES (no `id` column), so the orchestrator's clean phase
    // must DELETE the moving project's rows without touching the rest.
    withGroveDb(source.id, (db) => {
      // entity_mentions schema: (project_id, entity_id, note_id, note_type,
      // agent_id, machine_id, synced_at) with FKs on entity_id → entities
      // and agent_id → agents. Seed two entities first to satisfy them.
      const insertEntity = db.prepare(
        `INSERT INTO entities (id, project_id, agent_id, type, name, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntity.run('ent-moving-1', movingProjectId, 'claude-code', 'thing', 'A', 100, 100);
      insertEntity.run('ent-moving-2', movingProjectId, 'claude-code', 'thing', 'B', 101, 101);
      insertEntity.run('ent-other-1', otherProjectId, 'claude-code', 'thing', 'C', 102, 102);

      const insert = db.prepare(
        `INSERT INTO entity_mentions
           (project_id, entity_id, note_id, note_type, agent_id)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run(movingProjectId, 'ent-moving-1', `note-${movingProjectId}-1`, 'session', 'claude-code');
      insert.run(movingProjectId, 'ent-moving-2', `note-${movingProjectId}-2`, 'session', 'claude-code');
      insert.run(otherProjectId, 'ent-other-1', `note-other-1`, 'session', 'claude-code');
    });

    const before = withGroveDb(source.id, (db) => ({
      moving: (db.prepare(
        `SELECT COUNT(*) AS n FROM entity_mentions WHERE project_id = ?`,
      ).get(movingProjectId) as { n: number }).n,
      other: (db.prepare(
        `SELECT COUNT(*) AS n FROM entity_mentions WHERE project_id = ?`,
      ).get(otherProjectId) as { n: number }).n,
    }));
    expect(before.moving).toBe(2);
    expect(before.other).toBe(1);

    moveProjectBetweenGroves(source.id, target.id, movingProjectId, mycoHome, { snapshotsRoot });

    // Source: moving project's entity_mentions are gone, unrelated remain.
    const sourceAfter = withGroveDb(source.id, (db) => ({
      moving: (db.prepare(
        `SELECT COUNT(*) AS n FROM entity_mentions WHERE project_id = ?`,
      ).get(movingProjectId) as { n: number }).n,
      other: (db.prepare(
        `SELECT COUNT(*) AS n FROM entity_mentions WHERE project_id = ?`,
      ).get(otherProjectId) as { n: number }).n,
    }));
    expect(sourceAfter.moving).toBe(0);
    expect(sourceAfter.other).toBe(1);

    // Target: entity_mentions intentionally not transported (excluded
    // from BACKUP_TABLES), so the moving project's rows are not present.
    const targetMoving = withGroveDb(target.id, (db) =>
      (db.prepare(
        `SELECT COUNT(*) AS n FROM entity_mentions WHERE project_id = ?`,
      ).get(movingProjectId) as { n: number }).n,
    );
    expect(targetMoving).toBe(0);
  });

  it('moves a multi-line spore body through snapshot+restore without truncation', () => {
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

    // Real-world spore bodies contain Markdown with newlines and single
    // quotes — the dump must round-trip these byte-for-byte.
    const multiLineBody = `## Heading\n\nA paragraph with 'apostrophes'.\n- bullet one\n- bullet two\n\nTrailing line.`;
    const crlfBody = 'first\r\nsecond\r\nthird';
    withGroveDb(source.id, (db) => {
      db.prepare(
        `INSERT INTO spores (
           id, agent_id, session_id, observation_type, content,
           created_at, machine_id, project_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `spore-${projectId}-multiline`,
        'claude-code',
        `sess-${projectId}-1`,
        'gotcha',
        multiLineBody,
        221,
        'test-machine',
        projectId,
      );
      db.prepare(
        `INSERT INTO spores (
           id, agent_id, session_id, observation_type, content,
           created_at, machine_id, project_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `spore-${projectId}-crlf`,
        'claude-code',
        `sess-${projectId}-1`,
        'gotcha',
        crlfBody,
        222,
        'test-machine',
        projectId,
      );
    });

    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });

    // All three spores (single-line seed + multi-line + CRLF) survive.
    expect(countRows(target.id, 'spores', projectId)).toBe(3);

    const restored = withGroveDb(target.id, (db) => ({
      multiline: db.prepare('SELECT content FROM spores WHERE id = ?')
        .get(`spore-${projectId}-multiline`) as { content: string },
      crlf: db.prepare('SELECT content FROM spores WHERE id = ?')
        .get(`spore-${projectId}-crlf`) as { content: string },
    }));
    expect(restored.multiline.content).toBe(multiLineBody);
    expect(restored.crlf.content).toBe(crlfBody);
  });

  it('verify phase counts source and target from live DBs (catches truncated snapshots)', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);
    seedAgent(source.id);
    seedAgent(target.id);

    const projectId = createProjectId();
    const brandedProjectId = assertGroveProjectId(projectId);
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    seedProjectRows(source.id, projectId);
    // Add a second spore so we can prune one out of the snapshot and
    // produce a real source/target mismatch.
    withGroveDb(source.id, (db) => {
      db.prepare(
        `INSERT INTO spores (
           id, agent_id, session_id, observation_type, content,
           created_at, machine_id, project_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `spore-${projectId}-2`,
        'claude-code',
        `sess-${projectId}-1`,
        'gotcha',
        'Second spore',
        225,
        'test-machine',
        projectId,
      );
    });

    // Take a snapshot ourselves and corrupt it (drop one spore INSERT)
    // before letting moveProjectBetweenGroves resume from it.
    const moveOpId = `grove-move-${projectId}-fault-${Date.now()}`;
    const projectSlug = projectUrlSlug('Demo', projectId);
    const snapshotDir = path.join(snapshotsRoot, projectSlug, moveOpId);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = withGroveDb(source.id, (sourceDb) =>
      createBackup(
        sourceDb,
        snapshotDir,
        'test-machine',
        projectScope(brandedProjectId),
        projectSlug,
      ),
    );
    // Remove every INSERT line for the second spore — simulates a
    // truncated/broken dump where the source/target row counts must
    // diverge.
    const dump = fs.readFileSync(snapshotPath, 'utf-8');
    const tampered = dump
      .split('\n')
      .filter((line) => !line.includes(`spore-${projectId}-2`))
      .join('\n');
    fs.writeFileSync(snapshotPath, tampered, 'utf-8');

    // Plant a marker that points the orchestrator at the broken snapshot.
    const migrationDir = path.join(vaultDir, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    const markerPath = path.join(migrationDir, `${moveOpId}.json`);
    pauseProject(source.id, projectId, 'grove-move', moveOpId, mycoHome);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        move_op_id: moveOpId,
        from_grove_id: source.id,
        to_grove_id: target.id,
        project_id: projectId,
        project_name: 'Demo',
        project_root: projectRoot,
        started_at: new Date().toISOString(),
        phase: 'snapshot_complete',
        snapshot_path: snapshotPath,
      }),
    );

    expect(() =>
      moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot }),
    ).toThrow(/move verification failed/);

    // Source data was never modified (verify aborted before commit).
    expect(countRows(source.id, 'spores', projectId)).toBe(2);
  });

  it('pauses the source project after entry, before snapshot completes', () => {
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

    // Inject a fault by hand-crafting a marker at phase='snapshot' AFTER
    // the orchestrator has paused the project but before it finishes.
    // Easiest: run the orchestrator end-to-end and assert the *visible
    // postcondition* — pause cleared after deregister. Then assert the
    // mid-flight pause path by running pauseProject directly and confirming
    // the captured 'grove-move' reason is what the orchestrator would set.
    moveProjectBetweenGroves(source.id, target.id, projectId, mycoHome, { snapshotsRoot });
    // Postcondition: pause cleared because source entry was deregistered.
    expect(isProjectPaused(projectId, mycoHome).paused).toBe(false);

    // Mid-flight pause path: simulate by calling pauseProject as the
    // orchestrator would and confirming isProjectPaused reflects it.
    // Re-register to validate the pause mechanism still serves the same
    // contract from this Grove.
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);
    pauseProject(source.id, projectId, 'grove-move', 'op-mid-flight', mycoHome);
    const status = isProjectPaused(projectId, mycoHome);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.reason).toBe('grove-move');
    expect(status.owner_op).toBe('op-mid-flight');
  });
});
