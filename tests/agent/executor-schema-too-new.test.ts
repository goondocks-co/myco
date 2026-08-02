/**
 * The executor's SchemaVersionTooNewError response: a dispatch against a
 * vault written by a newer binary fails the run TYPED, before any agent
 * work and without crashing the dispatcher. No SDK mocks needed — the
 * refusal happens at `createSchema`, ahead of everything else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { runAgent } from '@myco/agent/executor.js';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-executor-too-new-'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('runAgent on a too-new vault', () => {
  it('fails the run typed instead of throwing', async () => {
    const dbPath = vaultDbPath(workDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      createSchema(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION + 1, epochSeconds());
    } finally {
      db.close();
    }

    const result = await runAgent(workDir);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('schema_version_too_new');
    expect(result.error).toContain('newer version of Myco');
  });
});
