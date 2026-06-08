/**
 * Regression tests for backup multi-line text serialization.
 *
 * The backup format is line-based on restore — every INSERT must occupy
 * exactly one line of the dump file or the parser drops everything after
 * the first newline. Multi-line text values (spore bodies, plan content,
 * digest content, canopy entry comments) caused the move's verify phase
 * to report dropped rows.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTestDb, setupTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import {
  ALL_PROJECTS_SCOPE,
  createBackup,
  restoreBackup,
} from '@myco/backup/engine.js';

const MACHINE = 'multilinetest_aaaa1111';
const AGENT_ID = 'test-agent';

const epochNow = () => Math.floor(Date.now() / 1000);

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-multiline-'));
}

function seedAgent(): void {
  registerAgent({
    id: AGENT_ID,
    name: 'Test Agent',
    source: 'built-in',
    created_at: epochNow(),
  });
}

function seedSession(id: string): void {
  upsertSession({
    id,
    agent: 'claude-code',
    started_at: epochNow(),
    created_at: epochNow(),
    machine_id: MACHINE,
  });
}

function insertSporeWithContent(id: string, sessionId: string, content: string): void {
  insertSpore({
    id,
    agent_id: AGENT_ID,
    session_id: sessionId,
    observation_type: 'gotcha',
    content,
    created_at: epochNow(),
    machine_id: MACHINE,
  });
}

function readSpore(id: string): { content: string } | undefined {
  return getDatabase()
    .prepare('SELECT content FROM spores WHERE id = ?')
    .get(id) as { content: string } | undefined;
}

function roundTrip(sporeId: string, sessionId: string, body: string, tmpDir: string): string {
  seedAgent();
  seedSession(sessionId);
  insertSporeWithContent(sporeId, sessionId, body);

  const snapshotPath = createBackup(getDatabase(), tmpDir, MACHINE, ALL_PROJECTS_SCOPE);

  // Drop the source row, then restore and re-read. Multi-line payloads
  // are emitted inline (single SQL string literal spanning newlines) —
  // restore relies on SQLite's own multi-statement parser, not a
  // line-based regex.
  getDatabase().prepare('DELETE FROM spores WHERE id = ?').run(sporeId);
  expect(readSpore(sporeId)).toBeFalsy();

  restoreBackup(getDatabase(), snapshotPath);
  const restored = readSpore(sporeId);
  expect(restored).toBeTruthy();
  return restored!.content;
}

describe('backup multi-line text round-trip', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves a spore body with embedded LF newlines and single quotes', () => {
    const body = `## Multi-line content\n\nThis spore has:\n- a list\n- with newlines\n- and ''single'' quotes\n\nEnd.`;
    const restored = roundTrip('spore-lf', 'sess-lf', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves a spore body containing a CRLF line ending', () => {
    const body = 'line one\r\nline two\r\nline three';
    const restored = roundTrip('spore-crlf', 'sess-crlf', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves the single-line fast path (no newlines)', () => {
    const body = "simple body with no newlines and a 'quote'";
    const restored = roundTrip('spore-simple', 'sess-simple', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves a body that ends with a trailing newline', () => {
    const body = 'first\nsecond\n';
    const restored = roundTrip('spore-trail', 'sess-trail', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves a body that starts with a leading newline', () => {
    const body = '\nfirst\nsecond';
    const restored = roundTrip('spore-lead', 'sess-lead', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves a body that is exactly a single newline', () => {
    const body = '\n';
    const restored = roundTrip('spore-just-lf', 'sess-just-lf', body, tmpDir);
    expect(restored).toBe(body);
  });

  it('preserves an empty body', () => {
    const body = '';
    const restored = roundTrip('spore-empty', 'sess-empty', body, tmpDir);
    expect(restored).toBe(body);
  });
});
