import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_DDL } from '../../packages/myco-server/worker/src/db/schema.js';
import { renderSchemaSql } from '../../packages/myco-server/worker/src/db/migrate.js';
import { MEMBER_TOKEN_BYTE_QUOTA, SERVER_SCHEMA_VERSION } from '../../packages/myco-server/worker/src/constants.js';

const table = (name: string) => SCHEMA_DDL.find((s) => new RegExp(`CREATE TABLE .*\\b${name}\\b`).test(s))!;

describe('server schema', () => {
  it('scopes sessions and events by project', () => {
    expect(table('sessions')).toMatch(/PRIMARY KEY \(project_id, session_id\)/);
    expect(table('events')).toMatch(/PRIMARY KEY \(project_id, event_id\)/);
  });

  it('attributes every write to a token', () => {
    expect(table('events')).toMatch(/token_id\s+TEXT NOT NULL/);
    expect(table('sessions')).toMatch(/created_by_token_id TEXT NOT NULL/);
  });

  it('records server receipt time next to caller time', () => {
    expect(table('events')).toMatch(/created_at\s+INTEGER NOT NULL/);
    expect(table('events')).toMatch(/received_at\s+INTEGER NOT NULL/);
  });

  it('gives project_id referential identity and tracks token write volume', () => {
    expect(table('projects')).toBeDefined();
    expect(table('member_tokens')).toMatch(/REFERENCES projects/);
    expect(table('member_tokens')).toMatch(/bytes_written INTEGER NOT NULL DEFAULT 0/);
    expect(table('member_tokens')).toMatch(new RegExp(`CONSTRAINT member_tokens_quota CHECK \\(bytes_written <= ${MEMBER_TOKEN_BYTE_QUOTA}\\)`));
    expect(table('member_tokens')).not.toMatch(/last_seen_at/);
    expect(table('events')).toMatch(/payload_hash TEXT NOT NULL/);
  });

  it('is idempotent by construction', () => {
    for (const s of SCHEMA_DDL) expect(s).toMatch(/IF NOT EXISTS/);
  });

  it('renders into real SQLite and records the version', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(renderSchemaSql());
    expect((sqlite.query(`SELECT value FROM schema_meta WHERE key='version'`).get() as any).value)
      .toBe(String(SERVER_SCHEMA_VERSION));
  });
});
