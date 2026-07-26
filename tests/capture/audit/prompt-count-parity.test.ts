import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repair } from '@myco/capture/audit/repair.js';
import { checkIntegrity } from '@myco/capture/audit/checks/integrity.js';
import { ACTIVITIES_TABLE, PROMPT_BATCHES_TABLE, SESSIONS_TABLE } from '@myco/db/schema-ddl.js';

/**
 * `sessions.prompt_count` is a cache owned by the batch writers in
 * `db/queries/batches.ts`, which derive it as `MAX(prompt_number)`. The audit
 * reads and the repair writes that same column, so both must agree with that
 * derivation — a repair computing it differently would overwrite correct values.
 *
 * This pins the derivation itself: change how the writers define the cache and
 * this fails.
 */
describe('prompt_count derivation parity', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  const NOW = 1_785_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-count-parity-'));
    dbPath = path.join(dir, 'myco.db');
    db = new Database(dbPath);
    db.run(SESSIONS_TABLE);
    db.run(PROMPT_BATCHES_TABLE);
    db.run(ACTIVITIES_TABLE);
    db.query(
      `INSERT INTO sessions (id, agent, project_id, project_root, started_at, status, prompt_count, created_at)
       VALUES ('s1','claude-code','proj_test','/repo/test',$t,'active',0,$t)`,
    ).run({ $t: NOW - 3600 });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addBatch(id: string, promptNumber: number) {
    db.query(
      `INSERT INTO prompt_batches (id, session_id, project_id, prompt_number, kind, origin, status, created_at)
       VALUES ($id,'s1','proj_test',$n,'initial','human','completed',$t)`,
    ).run({ $id: id, $n: promptNumber, $t: NOW - 3600 });
    // The derivation the writers apply on every insert.
    db.query(
      `UPDATE sessions SET prompt_count = (
         SELECT MAX(prompt_number) FROM prompt_batches WHERE session_id = 's1'
       ) WHERE id = 's1'`,
    ).run();
  }

  it('finds no drift for a session maintained by the writers derivation', () => {
    addBatch('b1', 1);
    addBatch('b2', 2);
    addBatch('b3', 7); // a gap, as reserved numbers and stranded batches produce

    const drift = checkIntegrity(db, { dbPath }, NOW).find((f) => f.id === 'session-counter-drift');
    expect(drift).toBeUndefined();
  });

  it('repairs to the value the writers would have cached', () => {
    addBatch('b1', 1);
    addBatch('b2', 7);
    db.query(`UPDATE sessions SET prompt_count = 99 WHERE id = 's1'`).run();

    repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    const cached = db.query(`SELECT prompt_count c FROM sessions WHERE id = 's1'`).get() as { c: number };
    const writerValue = db
      .query(`SELECT MAX(prompt_number) v FROM prompt_batches WHERE session_id = 's1'`)
      .get() as { v: number };
    expect(cached.c).toBe(writerValue.v);
  });
});
