import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

/**
 * Regression guard for the v40→v41 brick: migrateV40ToV41 originally applied
 * the live SECONDARY_INDEXES set, which later grew indexes on
 * session_myco_tool_calls (a table created at v45) — so every vault stamped
 * 34–40 failed mid-chain with `no such table` and could never upgrade. The
 * migration now applies a DDL snapshot frozen at the v41 revision.
 *
 * Uses the authentic v40 fresh-vault fixture rather than a hand-built
 * minimal schema: the minimal-schema convention is exactly how the original
 * bug escaped per-migration tests.
 */

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'historical', 'v40.json');

describe('migrateV40ToV41 from an authentic v40 vault', () => {
  it('upgrades to SCHEMA_VERSION and installs the release-provenance schema', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as {
      version: number;
      statements: string[];
    };
    expect(fixture.version).toBe(40);

    const db = new Database(':memory:');
    for (const stmt of fixture.statements) db.exec(stmt);
    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (40, 0)`).run();

    createSchema(db);

    const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);

    for (const table of ['knowledge_git_provenance', 'knowledge_release_state']) {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table) as { n: number };
      expect(row.n, `missing table ${table}`).toBe(1);
    }

    const v41IndexNames = [
      'idx_knowledge_git_provenance_project_captured',
      'idx_knowledge_git_provenance_session',
      'idx_knowledge_git_provenance_prompt_batch',
      'idx_knowledge_git_provenance_head_sha',
      'idx_knowledge_git_provenance_status_hash',
      'idx_knowledge_release_state_project_checked',
      'idx_knowledge_release_state_record',
      'idx_knowledge_release_state_state',
      'idx_knowledge_release_state_session',
      'idx_knowledge_release_state_prompt_batch',
    ];
    for (const name of v41IndexNames) {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`,
      ).get(name) as { n: number };
      expect(row.n, `missing index ${name}`).toBe(1);
    }

    db.close();
  });
});
