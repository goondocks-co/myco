/**
 * Verifies the v50 migration: materialize `activities.myco_tool` / `myco_op`.
 *
 * Pre-v50, a CLI-routed Myco call was stored as a raw `Bash` activity and its
 * Myco identity was reconstructed on read (a per-batch UI chip overlay). v50
 * moves identity resolution to the capture write boundary and backfills the new
 * columns for existing rows via the shared `resolveMycoToolIdentity`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

function seedV49Database(dbPath: string): void {
  const db = new Database(dbPath);
  createSchema(db as never);
  // Drop the new columns to simulate a genuine v49 schema, then roll the
  // version back so createSchema re-applies v50 (ADD COLUMN + backfill).
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (49, ?)').run(epochSeconds());
  db.exec('ALTER TABLE activities DROP COLUMN myco_tool');
  db.exec('ALTER TABLE activities DROP COLUMN myco_op');
  db.close();
}

describe('migrateV49ToV50 — activities Myco tool identity backfill', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v50-'));
    dbPath = path.join(tmpDir, 'myco.db');
    seedV49Database(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedActivities(): Record<string, number> {
    const seed = new Database(dbPath);
    const now = epochSeconds();
    seed.prepare(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s', 'claude-code', ?, ?)`).run(now, now);
    seed.prepare(
      `INSERT INTO prompt_batches (id, session_id, prompt_number, started_at, created_at, kind, status, machine_id, origin)
       VALUES (1, 's', 1, ?, ?, 'initial', 'active', 'local', 'human')`,
    ).run(now, now);
    const insert = seed.prepare(
      `INSERT INTO activities (session_id, prompt_batch_id, tool_name, tool_input, timestamp, processed, created_at)
       VALUES ('s', 1, ?, ?, ?, 0, ?)`,
    );
    const rows: Array<[string, string, string | null]> = [
      ['mcp', 'mcp__myco__myco_cortex', JSON.stringify({ op: 'canopy_map' })],
      ['cli', 'Bash', JSON.stringify({ command: `node .agents/myco-cli.cjs tool call myco_spores --input '{"op":"save"}'` })],
      ['bare', 'myco_search', JSON.stringify({ query: 'x' })],
      ['plain', 'Read', JSON.stringify({ file_path: '/x' })],
    ];
    const ids: Record<string, number> = {};
    rows.forEach(([label, name, input], i) => {
      ids[label] = Number(insert.run(name, input, now + i, now + i).lastInsertRowid);
    });
    seed.close();
    return ids;
  }

  function runMigrations(): void {
    initDatabase(dbPath, { embeddingDimensions: 1024 });
    createSchema(getDatabase());
  }

  it('adds the columns and backfills MCP, CLI, and bare Myco identities; leaves non-Myco null', () => {
    const ids = seedActivities();
    runMigrations();
    const db = getDatabase();
    const row = (id: number) =>
      db.prepare('SELECT myco_tool, myco_op FROM activities WHERE id = ?').get(id) as { myco_tool: string | null; myco_op: string | null };

    expect(row(ids.mcp)).toEqual({ myco_tool: 'myco_cortex', myco_op: 'canopy_map' });
    expect(row(ids.cli)).toEqual({ myco_tool: 'myco_spores', myco_op: 'save' });
    expect(row(ids.bare)).toEqual({ myco_tool: 'myco_search', myco_op: '' });
    expect(row(ids.plain)).toEqual({ myco_tool: null, myco_op: null });
  });

  it('records schema version 50 (and all subsequent migrations up to current)', () => {
    seedActivities();
    runMigrations();
    const v = getDatabase().prepare('SELECT version FROM schema_version WHERE version = 50').get() as { version: number } | undefined;
    expect(v?.version).toBe(50);
  });
});
