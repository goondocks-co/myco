/**
 * Gates for the v7 intelligence schema.
 *
 * `docs/architecture/myco-2.0.md` §7.6 is the feature-preservation ledger for
 * data classes, and a table that reaches v2.0.0 with no server home is a
 * capability dropped by omission rather than by decision. These gates fail BY
 * NAME so a missing table names itself: a count would report the same failure
 * for a table deleted and a table renamed, which is the shape of gate that
 * survives a change it should have caught.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

/**
 * The intelligence tables v7 creates.
 *
 * Two are Deployment-scoped: an agent's identity and the task catalogue serve
 * every Project a Deployment holds, so they carry no `project_id`. Every other
 * table here is Project data.
 */
const DEPLOYMENT_SCOPED = ['agents', 'agent_tasks'] as const;
/**
 * Append-only logs whose primary key is the insertion sequence.
 *
 * Readers page through these with `ORDER BY id` and an `id > ?` cursor, so the
 * id has to be monotonic. SQLite requires an AUTOINCREMENT column to be the whole
 * primary key, so these alone cannot lead their key with `project_id`; they are
 * still Project-scoped, and carry the grammar CHECK and project-leading indexes
 * every other table does.
 */
const SEQUENCED = [
  'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports',
  'digest_extract_revisions', 'knowledge_git_provenance',
] as const;

const PROJECT_SCOPED = [
  'agent_runs', 'agent_state',
  'spores', 'resolution_events', 'skill_records', 'skill_candidates', 'skill_lineage', 'skill_usage',
  'digest_extracts', 'cortex_instructions', 'knowledge_release_state',
  ...SEQUENCED,
] as const;
const V7_TABLES = [...DEPLOYMENT_SCOPED, ...PROJECT_SCOPED];

/** Team Host sync columns. Team Host is retired, and attribution rides the run and the credential. */
const RETIRED_SYNC_COLUMNS = ['machine_id', 'synced_at', 'received_at'];

/**
 * Rows §7.6 assigns to #919 that are not a table this schema creates.
 *
 * `schema_version` is 1.4's own version row; the server stamps `schema_meta`
 * instead, so the capability is kept under a different name rather than dropped.
 * Naming it here is what keeps the omission a decision rather than an oversight.
 */
const LEDGER_ROWS_WITHOUT_A_TABLE = new Set(['schema_version']);

const v7 = SCHEMA_STEPS.find((s) => s.version === 7)!;

function applied(): Database {
  const db = new Database(':memory:');
  for (const step of SCHEMA_STEPS) for (const s of step.statements) db.exec(s);
  return db;
}

interface Column { name: string; notnull: number }
const columns = (db: Database, table: string): Column[] => db.query(`PRAGMA table_info(${table})`).all() as Column[];

describe('v7 intelligence schema', () => {
  it('creates every table the ledger names, by name', () => {
    const db = applied();
    const present = new Set((db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name));
    expect(V7_TABLES.filter((t) => !present.has(t))).toEqual([]);
    db.close();
  });

  it('creates a table for every ledger row that names this issue as its owner, so the gate reads the ledger rather than only its own list', () => {
    // Section 7.6 alone: #919 also owns CLI, dashboard, MCP and config rows in
    // other sections, and those are not tables. Slicing the section keeps this a
    // schema gate rather than a whole-issue one.
    const ledger = fs.readFileSync(LEDGER_PATH, 'utf8');
    const section = ledger.slice(ledger.indexOf('### 7.6'), ledger.indexOf('### 7.7'));
    const owned = section.split('\n')
      .filter((l) => l.startsWith('| `') && /\|\s*#919\s*\|?\s*$/.test(l))
      .map((l) => l.match(/^\| `([^`]+)`/)?.[1])
      .filter((t): t is string => Boolean(t))
      .filter((t) => !LEDGER_ROWS_WITHOUT_A_TABLE.has(t));
    expect(owned.filter((t) => !V7_TABLES.includes(t as (typeof V7_TABLES)[number]))).toEqual([]);
  });

  it('keeps every table it creates a KEEP row in the ledger, so a table cannot be added here that the ledger drops', () => {
    const ledger = fs.readFileSync(LEDGER_PATH, 'utf8');
    const dropped = V7_TABLES.filter((t) => {
      const row = ledger.split('\n').find((l) => l.startsWith(`| \`${t}\``));
      return !row || !row.split('|')[2]?.trim().startsWith('KEEP');
    });
    expect(dropped).toEqual([]);
  });

  it('declares project_id NOT NULL on every Project-scoped table', () => {
    const db = applied();
    const nullable = PROJECT_SCOPED.filter((t) => {
      const col = columns(db, t).find((c) => c.name === 'project_id');
      return !col || col.notnull !== 1;
    });
    expect(nullable).toEqual([]);
    db.close();
  });

  it('gives the two Deployment-scoped tables no project_id, so the exception stays exactly two tables wide', () => {
    const db = applied();
    expect(DEPLOYMENT_SCOPED.filter((t) => columns(db, t).some((c) => c.name === 'project_id'))).toEqual([]);
    db.close();
  });

  it('leads every Project-scoped primary key with project_id, except the sequenced logs', () => {
    const db = applied();
    const wrong = PROJECT_SCOPED.filter((t) => !SEQUENCED.includes(t as (typeof SEQUENCED)[number])).filter((t) => {
      const pk = (db.query(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
        .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      return pk[0]?.name !== 'project_id';
    });
    expect(wrong).toEqual([]);
    db.close();
  });

  it('carries no retired Team Host sync column on any table it creates', () => {
    const db = applied();
    const carried = V7_TABLES.flatMap((t) =>
      columns(db, t).filter((c) => RETIRED_SYNC_COLUMNS.includes(c.name)).map((c) => `${t}.${c.name}`));
    expect(carried).toEqual([]);
    db.close();
  });

  it('gives every sequenced log a monotonic integer key, so ORDER BY id is insertion order', () => {
    const db = applied();
    const wrong = SEQUENCED.filter((t) => {
      const id = (db.query(`PRAGMA table_info(${t})`).all() as { name: string; type: string; pk: number }[])
        .find((c) => c.name === 'id');
      const sql = (db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(t) as { sql: string }).sql;
      return id?.type !== 'INTEGER' || id.pk !== 1 || !/AUTOINCREMENT/i.test(sql);
    });
    expect(wrong).toEqual([]);
    db.close();
  });

  it('gives no other table an AUTOINCREMENT, so the exception does not spread', () => {
    const db = applied();
    const spread = V7_TABLES.filter((t) => !SEQUENCED.includes(t as (typeof SEQUENCED)[number])).filter((t) => {
      const sql = (db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(t) as { sql: string }).sql;
      return /AUTOINCREMENT/i.test(sql);
    });
    expect(spread).toEqual([]);
    db.close();
  });

  it('keeps one current digest per agent and tier within a Project', () => {
    const db = applied();
    const unique = (db.query(`SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_digest_extracts_project_agent_tier'`)
      .get() as { sql: string } | null)?.sql;
    expect(unique).toMatch(/UNIQUE INDEX .* ON digest_extracts \(project_id, agent_id, tier\)/);
    db.close();
  });

  it('records the credential that dispatched a run, so member and runtime attribution is reachable', () => {
    const db = applied();
    expect(columns(db, 'agent_runs').some((c) => c.name === 'dispatched_by')).toBe(true);
    db.close();
  });
});
