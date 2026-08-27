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
const PROJECT_SCOPED = [
  'agent_runs', 'agent_run_events', 'agent_run_write_intents', 'agent_turns', 'agent_reports', 'agent_state',
  'spores', 'resolution_events', 'skill_records', 'skill_candidates', 'skill_lineage', 'skill_usage',
  'digest_extracts', 'digest_extract_revisions', 'cortex_instructions',
  'knowledge_git_provenance', 'knowledge_release_state',
] as const;
const V7_TABLES = [...DEPLOYMENT_SCOPED, ...PROJECT_SCOPED];

/** Team Host sync columns. Team Host is retired, and attribution rides the run and the credential. */
const RETIRED_SYNC_COLUMNS = ['machine_id', 'synced_at', 'received_at'];

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

  it('leads every Project-scoped primary key with project_id', () => {
    const db = applied();
    const wrong = PROJECT_SCOPED.filter((t) => {
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

  it('uses no AUTOINCREMENT, which SQLite allows only as a whole primary key and so cannot lead with project_id', () => {
    expect(v7.statements.filter((s) => /AUTOINCREMENT/i.test(s))).toEqual([]);
  });
});
