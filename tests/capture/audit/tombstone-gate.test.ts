import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkReconcile } from '@myco/capture/audit/checks/reconcile.js';
import { symbiontContexts } from '@myco/capture/audit/context.js';
import {
  ACTIVITIES_TABLE,
  PROMPT_BATCHES_TABLE,
  SESSIONS_TABLE,
  SESSION_TOMBSTONES_TABLE,
} from '@myco/db/schema-ddl.js';

/**
 * Myco never deletes the agent's own transcript, so a deliberately deleted
 * session outlives its row on disk. Reporting that file as never-captured
 * tells the reader to recover data they chose to remove — and if the same
 * candidate set ever drives an importer, it resurrects it.
 */
describe('reverse sweep tombstone gate', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  const NOW = 1_785_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tombstone-gate-'));
    dbPath = path.join(dir, 'myco.db');
    db = new Database(dbPath);
    db.run(SESSIONS_TABLE);
    db.run(PROMPT_BATCHES_TABLE);
    db.run(ACTIVITIES_TABLE);
    db.run(SESSION_TOMBSTONES_TABLE);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs against a vault that has the tombstone table', () => {
    const { findings } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('opencode'));
    expect(findings).toEqual([]);
  });

  it('degrades rather than throwing on a vault predating the table', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tombstone-legacy-'));
    const legacyPath = path.join(legacyDir, 'myco.db');
    const legacy = new Database(legacyPath);
    legacy.run(SESSIONS_TABLE);
    legacy.run(PROMPT_BATCHES_TABLE);
    try {
      expect(() =>
        checkReconcile(legacy, { dbPath: legacyPath }, NOW, symbiontContexts('opencode')),
      ).not.toThrow();
    } finally {
      legacy.close();
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
