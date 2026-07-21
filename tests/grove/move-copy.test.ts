import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { GROVE_PROJECT_SCOPED_TABLES, TABLE_DDLS } from '@myco/db/schema-ddl.js';
import {
  MOVE_COPY_TABLES,
  MOVE_FK_REMAPS,
  MOVE_REKEYED_TABLES,
  copyProjectBetweenGroveDbs,
  deleteProjectRowsForMove,
  findOrphanRemappedRows,
} from '@myco/grove/move-copy.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';

let tmpDir: string;
let mycoHome: string;
let projectRoot: string;
let snapshotsRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-move-copy-'));
  mycoHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  snapshotsRoot = path.join(tmpDir, 'snapshots');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  const vaultDir = resolveProjectVaultDir(projectRoot);
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

function seedAgent(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
     VALUES ('claude-code', 'Claude Code', 'built-in', 1, 100)`,
  ).run();
}

/** Tables seeded by `seedRichProject`, in a stable snapshot order. */
const RICH_TABLES = [
  'sessions',
  'prompt_batches',
  'knowledge_git_provenance',
  'knowledge_release_state',
  'activities',
  'plans',
  'attachments',
  'spores',
  'entities',
  'entity_mentions',
  'digest_extracts',
  'agent_runs',
  'agent_reports',
  'agent_turns',
  'agent_run_write_intents',
  'digest_extract_revisions',
  'log_entries',
];

/**
 * Seed a project across every rekeyed table plus the FK-carrying text
 * tables. The still-integer tables (knowledge_git_provenance, activities,
 * agent_reports/turns/write_intents, digest_extract_revisions, log_entries)
 * use EXPLICIT integer ids from `base`, so two projects seeded with the same
 * base collide on every AUTOINCREMENT primary key and exercise the move's
 * integer remap. prompt_batches, knowledge_release_state, and digest_extracts
 * now carry globally-unique Grove-era text ids (keyed by `sfx`) — they never
 * collide and are copied id-preserving.
 *
 * Layout: `parent-batch` is the parent of `child-batch`; plans/spores/kgp/krs
 * reference the parent batch; activities/attachments reference the child batch;
 * digest_extract_revision `base` is the parent of revision `base+1`.
 */
function seedRichProject(db: Database, projectId: string, sfx: string, base: number): void {
  seedAgent(db);
  const parentBatchId = `pbat_${sfx}_parent`;
  const childBatchId = `pbat_${sfx}_child`;
  db.prepare(
    `INSERT INTO sessions (id, agent, project_root, project_id, started_at, created_at, machine_id)
     VALUES (?, 'claude-code', ?, ?, 100, 100, 'test-machine')`,
  ).run(`sess-${sfx}`, projectRoot, projectId);
  db.prepare(
    `INSERT INTO prompt_batches (id, project_id, session_id, user_prompt, created_at)
     VALUES (?, ?, ?, ?, 110)`,
  ).run(parentBatchId, projectId, `sess-${sfx}`, `parent-batch-${sfx}`);
  db.prepare(
    `INSERT INTO prompt_batches (id, project_id, session_id, parent_prompt_batch_id, user_prompt, created_at)
     VALUES (?, ?, ?, ?, ?, 111)`,
  ).run(childBatchId, projectId, `sess-${sfx}`, parentBatchId, `child-batch-${sfx}`);
  db.prepare(
    `INSERT INTO knowledge_git_provenance (id, project_id, identity_key, session_id, prompt_batch_id, capture_point, captured_at, status_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'prompt', 120, 'hash', 120)`,
  ).run(base, projectId, `kgp-${sfx}`, `sess-${sfx}`, parentBatchId);
  db.prepare(
    `INSERT INTO knowledge_release_state (id, project_id, identity_key, namespace, record_id, source_prompt_batch_id, state, confidence, checked_at, created_at)
     VALUES (?, ?, ?, 'spores', ?, ?, 'released', 'high', 130, 130)`,
  ).run(`krel_${sfx}`, projectId, `krs-${sfx}`, `rec-${sfx}`, parentBatchId);
  db.prepare(
    `INSERT INTO activities (id, project_id, session_id, prompt_batch_id, tool_name, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, 140, 140)`,
  ).run(base, projectId, `sess-${sfx}`, childBatchId, `tool-${sfx}`);
  db.prepare(
    `INSERT INTO plans (id, project_id, logical_key, title, prompt_batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, 150)`,
  ).run(`plan-${sfx}`, projectId, `plan:${sfx}`, `Plan ${sfx}`, parentBatchId);
  db.prepare(
    `INSERT INTO attachments (id, project_id, session_id, prompt_batch_id, file_path, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 160)`,
  ).run(`att-${sfx}`, projectId, `sess-${sfx}`, childBatchId, `/tmp/${sfx}.png`, Buffer.from([1, 2, 3, base]));
  db.prepare(
    `INSERT INTO spores (id, project_id, agent_id, session_id, prompt_batch_id, observation_type, content, created_at)
     VALUES (?, ?, 'claude-code', ?, ?, 'gotcha', ?, 170)`,
  ).run(`spore-${sfx}`, projectId, `sess-${sfx}`, parentBatchId, `spore content ${sfx}`);
  db.prepare(
    `INSERT INTO entities (id, project_id, agent_id, type, name, first_seen, last_seen)
     VALUES (?, ?, 'claude-code', 'thing', ?, 180, 180)`,
  ).run(`ent-${sfx}`, projectId, `name-${sfx}`);
  db.prepare(
    `INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id)
     VALUES (?, ?, ?, 'session', 'claude-code')`,
  ).run(projectId, `ent-${sfx}`, `note-${sfx}`);
  db.prepare(
    `INSERT INTO digest_extracts (id, project_id, agent_id, tier, content, generated_at)
     VALUES (?, ?, 'claude-code', 1, ?, 190)`,
  ).run(`dext_${sfx}`, projectId, `digest ${sfx}`);
  db.prepare(
    `INSERT INTO agent_runs (id, project_id, agent_id, task, status)
     VALUES (?, ?, 'claude-code', 'digest', 'completed')`,
  ).run(`run-${sfx}`, projectId);
  db.prepare(
    `INSERT INTO agent_reports (id, project_id, run_id, agent_id, action, summary, created_at)
     VALUES (?, ?, ?, 'claude-code', 'observe', ?, 200)`,
  ).run(base, projectId, `run-${sfx}`, `summary ${sfx}`);
  db.prepare(
    `INSERT INTO agent_turns (id, project_id, run_id, agent_id, turn_number, tool_name)
     VALUES (?, ?, ?, 'claude-code', 1, ?)`,
  ).run(base, projectId, `run-${sfx}`, `turn-tool-${sfx}`);
  db.prepare(
    `INSERT INTO agent_run_write_intents (id, project_id, run_id, tool_name, tool_input, synthetic_output, recorded_at)
     VALUES (?, ?, ?, ?, '{}', '{}', 210)`,
  ).run(base, projectId, `run-${sfx}`, `intent-tool-${sfx}`);
  db.prepare(
    `INSERT INTO digest_extract_revisions (id, project_id, agent_id, tier, content, run_id, created_at)
     VALUES (?, ?, 'claude-code', 1, ?, ?, 220)`,
  ).run(base, projectId, `parent-rev-${sfx}`, `run-${sfx}`);
  db.prepare(
    `INSERT INTO digest_extract_revisions (id, project_id, agent_id, tier, content, run_id, parent_revision_id, created_at)
     VALUES (?, ?, 'claude-code', 1, ?, ?, ?, 221)`,
  ).run(base + 1, projectId, `child-rev-${sfx}`, `run-${sfx}`, base);
  db.prepare(
    `INSERT INTO log_entries (id, project_id, timestamp, level, component, kind, message, session_id)
     VALUES (?, ?, '2026-06-10T00:00:00Z', 'info', 'test', 'event', ?, ?)`,
  ).run(base, projectId, `log message ${sfx}`, `sess-${sfx}`);
}

function snapshotProjectRows(db: Database, projectId: string): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of RICH_TABLES) {
    snapshot[table] = db.prepare(
      `SELECT * FROM ${table} WHERE project_id = ? ORDER BY rowid`,
    ).all(projectId);
  }
  return snapshot;
}

describe('move-copy DDL drift guards', () => {
  const createTableName = /CREATE TABLE IF NOT EXISTS (\w+)/;
  const intFkPattern = /(\w+)\s+INTEGER(?:\s+NOT\s+NULL)?\s+REFERENCES\s+(\w+)\s*\(\s*id\s*\)/g;

  it('MOVE_COPY_TABLES is the full project-scoped registry', () => {
    expect([...MOVE_COPY_TABLES]).toEqual([...GROVE_PROJECT_SCOPED_TABLES]);
  });

  it('MOVE_REKEYED_TABLES matches the integer-AUTOINCREMENT project-scoped tables in the DDL', () => {
    const projectScoped = new Set<string>(GROVE_PROJECT_SCOPED_TABLES);
    const fromDdl: string[] = [];
    for (const ddl of TABLE_DDLS) {
      const name = createTableName.exec(ddl)?.[1];
      if (!name || !projectScoped.has(name)) continue;
      if (/\bid\s+INTEGER PRIMARY KEY AUTOINCREMENT\b/.test(ddl)) fromDdl.push(name);
    }
    expect([...MOVE_REKEYED_TABLES].sort()).toEqual(fromDdl.sort());
  });

  it('MOVE_FK_REMAPS covers every integer FK into a rekeyed table, exactly', () => {
    const rekeyed = new Set<string>(MOVE_REKEYED_TABLES);
    const fromDdl: string[] = [];
    for (const ddl of TABLE_DDLS) {
      const name = createTableName.exec(ddl)?.[1];
      if (!name) continue;
      for (const match of ddl.matchAll(intFkPattern)) {
        const [, column, referenced] = match;
        if (!rekeyed.has(referenced)) continue;
        fromDdl.push(`${name}.${column}->${referenced}`);
      }
    }
    const declared = MOVE_FK_REMAPS.map((r) => `${r.table}.${r.column}->${r.via}`);
    expect(declared.sort()).toEqual(fromDdl.sort());
  });
});

describe('copyProjectBetweenGroveDbs', () => {
  it('moves a project into a NON-EMPTY target with colliding integer ids, remapping all FK columns', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);

    const movedProjectId = createProjectId();
    const residentProjectId = createProjectId();

    // The target already holds another project's rows whose integer ids
    // deliberately collide with the moved project's (same base).
    withGroveDb(target.id, (db) => seedRichProject(db, residentProjectId, 'resident', 1));
    withGroveDb(source.id, (db) => seedRichProject(db, movedProjectId, 'moved', 1));

    registerProjectInGrove(source.id, {
      projectId: movedProjectId,
      projectName: 'Demo',
      projectRoot,
    }, mycoHome);

    const residentBefore = withGroveDb(target.id, (db) =>
      snapshotProjectRows(db, residentProjectId),
    );

    moveProjectBetweenGroves(source.id, target.id, movedProjectId, mycoHome, { snapshotsRoot });

    withGroveDb(target.id, (db) => {
      // The resident project's rows are byte-identical to before the move.
      expect(snapshotProjectRows(db, residentProjectId)).toEqual(residentBefore);

      // Every moved row arrived.
      for (const table of RICH_TABLES) {
        const want = table === 'prompt_batches' || table === 'digest_extract_revisions' ? 2 : 1;
        const got = (db.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        ).get(movedProjectId) as { n: number }).n;
        expect(`${table}:${got}`).toBe(`${table}:${want}`);
      }

      // Globally-unique text ids are copied id-preserving (not remapped);
      // the child still points at the parent.
      const parentBatch = db.prepare(
        `SELECT id, parent_prompt_batch_id FROM prompt_batches WHERE user_prompt = 'parent-batch-moved'`,
      ).get() as { id: string; parent_prompt_batch_id: string | null };
      const childBatch = db.prepare(
        `SELECT id, parent_prompt_batch_id FROM prompt_batches WHERE user_prompt = 'child-batch-moved'`,
      ).get() as { id: string; parent_prompt_batch_id: string | null };
      expect(parentBatch.id).toBe('pbat_moved_parent');
      expect(childBatch.id).toBe('pbat_moved_child');
      expect(parentBatch.parent_prompt_batch_id).toBeNull();
      expect(childBatch.parent_prompt_batch_id).toBe(parentBatch.id);

      // The prompt-batch FK columns carry the preserved text ids.
      const kgp = db.prepare(
        `SELECT prompt_batch_id FROM knowledge_git_provenance WHERE identity_key = 'kgp-moved'`,
      ).get() as { prompt_batch_id: string };
      expect(kgp.prompt_batch_id).toBe(parentBatch.id);
      const krs = db.prepare(
        `SELECT source_prompt_batch_id FROM knowledge_release_state WHERE identity_key = 'krs-moved'`,
      ).get() as { source_prompt_batch_id: string };
      expect(krs.source_prompt_batch_id).toBe(parentBatch.id);
      const activity = db.prepare(
        `SELECT prompt_batch_id FROM activities WHERE tool_name = 'tool-moved'`,
      ).get() as { prompt_batch_id: string };
      expect(activity.prompt_batch_id).toBe(childBatch.id);
      const plan = db.prepare(
        `SELECT prompt_batch_id FROM plans WHERE id = 'plan-moved'`,
      ).get() as { prompt_batch_id: string };
      expect(plan.prompt_batch_id).toBe(parentBatch.id);
      const attachment = db.prepare(
        `SELECT prompt_batch_id, data FROM attachments WHERE id = 'att-moved'`,
      ).get() as { prompt_batch_id: string; data: Uint8Array };
      expect(attachment.prompt_batch_id).toBe(childBatch.id);
      expect(Buffer.from(attachment.data)).toEqual(Buffer.from([1, 2, 3, 1]));
      const spore = db.prepare(
        `SELECT prompt_batch_id FROM spores WHERE id = 'spore-moved'`,
      ).get() as { prompt_batch_id: string };
      expect(spore.prompt_batch_id).toBe(parentBatch.id);

      // Self-FK revision chain remapped the same way.
      const parentRev = db.prepare(
        `SELECT id FROM digest_extract_revisions WHERE content = 'parent-rev-moved'`,
      ).get() as { id: number };
      const childRev = db.prepare(
        `SELECT id, parent_revision_id FROM digest_extract_revisions WHERE content = 'child-rev-moved'`,
      ).get() as { id: number; parent_revision_id: number };
      expect(parentRev.id).not.toBe(1);
      expect(childRev.parent_revision_id).toBe(parentRev.id);

      // entity_mentions rode along (the dump format excluded it; the copy doesn't).
      const mentions = db.prepare(
        `SELECT note_id FROM entity_mentions WHERE project_id = ?`,
      ).all(movedProjectId) as Array<{ note_id: string }>;
      expect(mentions).toEqual([{ note_id: 'note-moved' }]);

      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    // Source cleaned of the moved project's rows.
    withGroveDb(source.id, (db) => {
      for (const table of RICH_TABLES) {
        const got = (db.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        ).get(movedProjectId) as { n: number }).n;
        expect(`${table}:${got}`).toBe(`${table}:0`);
      }
    });
  });

  it('is re-entrant: running the copy twice leaves a single copy of every row', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);

    const projectId = createProjectId();
    withGroveDb(source.id, (db) => seedRichProject(db, projectId, 'twice', 1));
    withGroveDb(target.id, (db) => seedAgent(db));

    const sourceDb = openDatabase(resolveGroveDbPath(source.id, mycoHome));
    const targetDb = openDatabase(resolveGroveDbPath(target.id, mycoHome));
    try {
      // Crash between copy-transaction commit and marker write replays
      // the whole copy phase; the wipe at the head of the transaction
      // must absorb the first pass.
      copyProjectBetweenGroveDbs(sourceDb, targetDb, projectId);
      copyProjectBetweenGroveDbs(sourceDb, targetDb, projectId);

      for (const table of RICH_TABLES) {
        const want = table === 'prompt_batches' || table === 'digest_extract_revisions' ? 2 : 1;
        const got = (targetDb.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        ).get(projectId) as { n: number }).n;
        expect(`${table}:${got}`).toBe(`${table}:${want}`);
      }
      expect(findOrphanRemappedRows(targetDb, projectId)).toEqual([]);
    } finally {
      targetDb.close();
      sourceDb.close();
    }
  });

  it('refuses to copy an integer-remapped row whose FK references a parent outside the moved project', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);

    const projectId = createProjectId();
    const otherProjectId = createProjectId();
    withGroveDb(source.id, (db) => {
      seedRichProject(db, projectId, 'main', 1);
      seedRichProject(db, otherProjectId, 'other', 10);
      // Cross-project remapped FK: a digest revision of the moved project
      // pointing at the OTHER project's revision. Reallocating the literal
      // integer id would attach it to an arbitrary target parent.
      db.run('PRAGMA foreign_keys = OFF');
      db.prepare(
        `UPDATE digest_extract_revisions SET parent_revision_id = 10 WHERE id = 2`,
      ).run();
      db.run('PRAGMA foreign_keys = ON');
    });

    const sourceDb = openDatabase(resolveGroveDbPath(source.id, mycoHome));
    const targetDb = openDatabase(resolveGroveDbPath(target.id, mycoHome));
    try {
      let caught: Error | undefined;
      try {
        copyProjectBetweenGroveDbs(sourceDb, targetDb, projectId);
      } catch (err) {
        caught = err as Error;
      }
      // The parent-chain sort refuses to order a child whose remapped parent
      // is not part of the moved project's rows, so the copy never inserts it.
      expect(caught?.message).toMatch(/Missing source digest_extract_revisions parent 10 for 2/);
      // The transaction rolled back: nothing landed in the target.
      const n = (targetDb.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?`,
      ).get(projectId) as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      targetDb.close();
      sourceDb.close();
    }
  });

  it('surfaces non-missing-table read errors instead of silently skipping the table', () => {
    const source = createGrove('Source', mycoHome);
    const target = createGrove('Target', mycoHome);
    ensureGroveDb(source.id);
    ensureGroveDb(target.id);

    const projectId = createProjectId();
    withGroveDb(source.id, (db) => {
      seedRichProject(db, projectId, 'main', 1);
      // A readable-but-broken table: project_id gone, so the project-
      // scoped SELECT fails with "no such column" — NOT a missing table.
      db.run('DROP INDEX idx_log_entries_project_id');
      db.run('ALTER TABLE log_entries DROP COLUMN project_id');
    });

    const sourceDb = openDatabase(resolveGroveDbPath(source.id, mycoHome));
    const targetDb = openDatabase(resolveGroveDbPath(target.id, mycoHome));
    try {
      expect(() => copyProjectBetweenGroveDbs(sourceDb, targetDb, projectId))
        .toThrow(/failed to read log_entries rows/);
      // The transaction rolled back: a half-copied project never lands.
      const n = (targetDb.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?`,
      ).get(projectId) as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      targetDb.close();
      sourceDb.close();
    }
  });
});

describe('findOrphanRemappedRows', () => {
  it('reports remapped children whose parent is missing or belongs to another project', () => {
    const grove = createGrove('Solo', mycoHome);
    ensureGroveDb(grove.id);
    const projectId = createProjectId();
    const otherProjectId = createProjectId();

    withGroveDb(grove.id, (db) => {
      seedRichProject(db, projectId, 'main', 1);
      seedRichProject(db, otherProjectId, 'other', 10);
      expect(findOrphanRemappedRows(db, projectId)).toEqual([]);

      db.run('PRAGMA foreign_keys = OFF');
      // The self-referential revision chain is the only remapped FK left after
      // the text-id rekey: point the moved project's child revision at a
      // missing parent so the orphan check fires.
      db.prepare(`UPDATE digest_extract_revisions SET parent_revision_id = 999 WHERE id = 2`).run();
      db.run('PRAGMA foreign_keys = ON');

      const problems = findOrphanRemappedRows(db, projectId);
      expect(problems).toHaveLength(1);
      expect(problems.join('; ')).toContain('digest_extract_revisions.parent_revision_id');
    });
  });

  it('throws on non-missing-table errors instead of silently skipping the check', () => {
    const grove = createGrove('Solo', mycoHome);
    ensureGroveDb(grove.id);
    const projectId = createProjectId();

    withGroveDb(grove.id, (db) => {
      seedRichProject(db, projectId, 'main', 1);
      // Break the one remapped table without removing it: the orphan query's
      // project_id filter now fails with "no such column" — a swallowed
      // error here would blind the verify phase the check serves.
      db.run('DROP INDEX IF EXISTS idx_digest_extract_revisions_project_id');
      db.run('ALTER TABLE digest_extract_revisions DROP COLUMN project_id');

      expect(() => findOrphanRemappedRows(db, projectId))
        .toThrow(/orphan check failed reading digest_extract_revisions\.parent_revision_id/);
    });
  });
});

describe('deleteProjectRowsForMove', () => {
  it('deletes only the given project id and surfaces injected delete failures', () => {
    const grove = createGrove('Solo', mycoHome);
    ensureGroveDb(grove.id);
    const projectId = createProjectId();
    const siblingProjectId = createProjectId();

    withGroveDb(grove.id, (db) => {
      seedRichProject(db, projectId, 'main', 1);
      seedRichProject(db, siblingProjectId, 'sibling', 10);

      deleteProjectRowsForMove(db, projectId);
      expect((db.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?`,
      ).get(projectId) as { n: number }).n).toBe(0);
      expect((db.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?`,
      ).get(siblingProjectId) as { n: number }).n).toBe(1);

      // An injected delete failure must surface AND roll the whole
      // deletion back — no partial cleanup.
      db.run(
        `CREATE TRIGGER block_spore_delete BEFORE DELETE ON spores
         BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`,
      );
      expect(() => deleteProjectRowsForMove(db, siblingProjectId))
        .toThrow(/spores: .*injected delete failure/);
      expect((db.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?`,
      ).get(siblingProjectId) as { n: number }).n).toBe(1);
    });
  });
});
