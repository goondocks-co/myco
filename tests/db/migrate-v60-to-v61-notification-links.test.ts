// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const now = 1_781_000_000;

function seedNotification(db: Database, id: string, link: string | null): void {
  db.prepare(
    `INSERT INTO notifications (
      id, project_id, domain, type, level, title, message, mode, status, link, metadata, created_at
    ) VALUES (?, NULL, 'agents', 'agent.task.success', 'info', ?, NULL, 'summary', 'unread', ?, NULL, ?)`,
  ).run(id, id, link, now);
}

function linkFor(db: Database, id: string): string | null {
  const row = db.prepare(`SELECT link FROM notifications WHERE id = ?`).get(id) as { link: string | null };
  return row.link;
}

describe('v60 -> v61 notification link migration', () => {
  it('canonicalizes old agent run notification links without changing unrelated links', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (60, ?)').run(now);

    seedNotification(db, 'run-param', '/agent?run=run-1');
    seedNotification(db, 'run-id-param', '/agent?runId=run-2');
    seedNotification(db, 'reordered-run-param', '/agent?tab=evaluations&run=run-4');
    seedNotification(db, 'reordered-run-id-param', '/agent?tab=runs&runId=run-5');
    seedNotification(db, 'encoded', '/agent?run=run%203');
    seedNotification(db, 'empty', '/agent?run=');
    seedNotification(db, 'agent-no-run', '/agent?tab=runs');
    seedNotification(db, 'other', '/sessions/s1');
    seedNotification(db, 'null-link', null);

    createSchema(db);

    expect(linkFor(db, 'run-param')).toBe('/agent/run-1');
    expect(linkFor(db, 'run-id-param')).toBe('/agent/run-2');
    expect(linkFor(db, 'reordered-run-param')).toBe('/agent/run-4');
    expect(linkFor(db, 'reordered-run-id-param')).toBe('/agent/run-5');
    expect(linkFor(db, 'encoded')).toBe('/agent/run%203');
    expect(linkFor(db, 'empty')).toBe('/agent?run=');
    expect(linkFor(db, 'agent-no-run')).toBe('/agent?tab=runs');
    expect(linkFor(db, 'other')).toBe('/sessions/s1');
    expect(linkFor(db, 'null-link')).toBeNull();

    const version = db.prepare(
      `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`,
    ).get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);

    createSchema(db);
    expect(linkFor(db, 'run-param')).toBe('/agent/run-1');
  });
});
