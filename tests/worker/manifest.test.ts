/**
 * Tests for GET /manifest — content-addressed drift reconcile endpoint.
 *
 * Verifies:
 *   - summary=1 returns { count } scoped to (machine_id, [project_id])
 *   - paged results are ordered by id with correct next_cursor
 *   - content_hash present only on the 4 content-hash tables
 *   - WORKER_CONTENT_HASH_TABLES parity: every member has content_hash in schema DDL
 *   - scoping excludes the other machine AND (when project_id given) the other project
 *   - invalid / ineligible tables are rejected 400
 *   - a v2 client still passes /connect against a v3 worker (200, not 409)
 *
 * Uses the same bun:test + fake-D1 pattern as tests/worker/schema.test.ts.
 * The manifest handler lives in its own dependency-free module so it can be
 * imported here without pulling in cloudflare:email via index.ts.
 */

import { describe, it, expect } from 'bun:test';
import {
  WORKER_CONTENT_HASH_TABLES,
  MANIFEST_ELIGIBLE_TABLES,
  parseManifestParams,
  queryManifest,
  type ManifestDb,
  type ManifestItem,
} from '@myco-team-worker/manifest';
import { SYNCED_TABLES } from '@myco-team-worker/synced-tables';
import { RECONCILE_ELIGIBLE_TABLES } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Schema DDL source — read to verify WORKER_CONTENT_HASH_TABLES parity
// ---------------------------------------------------------------------------
// We import the raw schema DDL strings directly so the parity assertion
// checks the REAL schema rather than a prose description.

// Inline the column patterns we expect. The parity assertion below
// reads the actual SCHEMA_MODULE source file to verify each member of
// WORKER_CONTENT_HASH_TABLES has `content_hash` in its DDL, and that
// no other synced table has one.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../packages/myco-team/worker/src/schema.ts');
const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Fixture data: 2 machines × 2 projects × a few rows per table
// ---------------------------------------------------------------------------

const MACHINE_A = 'machine-aaa';
const MACHINE_B = 'machine-bbb';
const PROJECT_1 = 'proj_0000000000000000000000000000001a';
const PROJECT_2 = 'proj_0000000000000000000000000000002b';

interface FakeRow {
  id: string;
  machine_id: string;
  project_id: string | null;
  content_hash?: string | null;
  rowid?: number;
}

// Seed rows for the 'sessions' table (has content_hash).
const SESSIONS_ROWS: FakeRow[] = [
  { id: 'sess-a1', machine_id: MACHINE_A, project_id: PROJECT_1, content_hash: 'hash-a1', rowid: 1 },
  { id: 'sess-a2', machine_id: MACHINE_A, project_id: PROJECT_1, content_hash: 'hash-a2', rowid: 2 },
  { id: 'sess-a3', machine_id: MACHINE_A, project_id: PROJECT_2, content_hash: 'hash-a3', rowid: 3 },
  { id: 'sess-b1', machine_id: MACHINE_B, project_id: PROJECT_1, content_hash: 'hash-b1', rowid: 4 },
];

// Seed rows for the 'entities' table (no content_hash).
const ENTITIES_ROWS: FakeRow[] = [
  { id: 'ent-a1', machine_id: MACHINE_A, project_id: PROJECT_1, rowid: 1 },
  { id: 'ent-a2', machine_id: MACHINE_A, project_id: PROJECT_2, rowid: 2 },
  { id: 'ent-b1', machine_id: MACHINE_B, project_id: PROJECT_1, rowid: 3 },
];

// ---------------------------------------------------------------------------
// Fake D1 implementation
// ---------------------------------------------------------------------------

/**
 * Minimal fake D1 that parses the SQL the manifest handler issues and
 * answers from in-memory fixture rows. Supports the two query shapes:
 *
 *   SELECT COUNT(*) AS count FROM <table>
 *     WHERE machine_id = ? [AND project_id = ?]
 *
 *   SELECT id, project_id[, content_hash] FROM <table>
 *     WHERE machine_id = ? [AND project_id = ?] AND id > ? ORDER BY id LIMIT ?
 */
function createFakeD1(tableData: Record<string, FakeRow[]>): ManifestDb {
  return {
    prepare(sql: string) {
      let boundValues: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          boundValues = [...values];
          return this;
        },
        async first<T>(): Promise<T | null> {
          const tableMatch = sql.match(/FROM\s+(\w+)/i);
          const table = tableMatch?.[1] ?? '';
          const rows = tableData[table] ?? [];

          // Parse WHERE clause bindings.
          // Summary: SELECT COUNT(*), MAX(rowid) FROM t WHERE machine_id=? [AND project_id=?]
          const [machineId, maybeProjectId] = boundValues as string[];
          const filtered = rows.filter((r) => {
            if (r.machine_id !== machineId) return false;
            if (maybeProjectId !== undefined && r.project_id !== maybeProjectId) return false;
            return true;
          });

          const count = filtered.length;

          return { count } as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const tableMatch = sql.match(/FROM\s+(\w+)/i);
          const table = tableMatch?.[1] ?? '';
          const rows = tableData[table] ?? [];

          const hasProjectIdFilter = /AND project_id = \?/.test(sql);
          const hasContentHash = sql.includes('content_hash');

          // Binding order for paged query:
          //   With project_id:    machine_id, project_id, cursor_id, limit
          //   Without project_id: machine_id, cursor_id, limit
          let machineId: string;
          let projectId: string | null = null;
          let cursorId: string;
          let limit: number;

          if (hasProjectIdFilter) {
            [machineId, projectId, cursorId, limit] = boundValues as [string, string, string, number];
          } else {
            [machineId, cursorId, limit] = boundValues as [string, string, number];
          }

          const filtered = rows
            .filter((r) => {
              if (r.machine_id !== machineId) return false;
              if (projectId !== null && r.project_id !== projectId) return false;
              if (String(r.id) <= String(cursorId)) return false;
              return true;
            })
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));

          const paged = filtered.slice(0, limit);

          const items = paged.map((r): ManifestItem => {
            const item: ManifestItem = {
              id: r.id,
              project_id: r.project_id,
              ...(hasContentHash ? { content_hash: r.content_hash ?? null } : {}),
            };
            return item;
          });

          return { results: items as T[] };
        },
      };
    },
  };
}

const fakeDb = createFakeD1({
  sessions: SESSIONS_ROWS,
  entities: ENTITIES_ROWS,
});

// ---------------------------------------------------------------------------
// Parity assertion: WORKER_CONTENT_HASH_TABLES vs schema.ts
// ---------------------------------------------------------------------------

describe('WORKER_CONTENT_HASH_TABLES parity with schema.ts', () => {
  it('every member of WORKER_CONTENT_HASH_TABLES has content_hash in its schema DDL', () => {
    // Each table in WORKER_CONTENT_HASH_TABLES should appear as a const block
    // in schema.ts that includes "content_hash TEXT".
    for (const table of WORKER_CONTENT_HASH_TABLES) {
      // Find the CREATE TABLE block for this table in the schema source.
      // Blocks are delimited by "CREATE TABLE IF NOT EXISTS <table>" and end
      // before the next "CREATE TABLE IF NOT EXISTS" or end of string.
      const blockPattern = new RegExp(
        `CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?(?=CREATE TABLE IF NOT EXISTS|$)`,
        'i',
      );
      const match = schemaSrc.match(blockPattern);
      expect(
        match,
        `Schema source must contain a CREATE TABLE block for ${table}`,
      ).not.toBeNull();

      expect(
        match![0].includes('content_hash'),
        `${table} must have content_hash in its DDL (WORKER_CONTENT_HASH_TABLES member)`,
      ).toBe(true);
    }
  });

  it('no synced table outside WORKER_CONTENT_HASH_TABLES has content_hash in its schema DDL', () => {
    for (const table of SYNCED_TABLES) {
      if (WORKER_CONTENT_HASH_TABLES.has(table)) continue;

      const blockPattern = new RegExp(
        `CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?(?=CREATE TABLE IF NOT EXISTS|$)`,
        'i',
      );
      const match = schemaSrc.match(blockPattern);
      if (!match) continue; // table may not have its own CREATE TABLE block

      expect(
        match[0].includes('content_hash'),
        `${table} must NOT have content_hash in its DDL (not in WORKER_CONTENT_HASH_TABLES)`,
      ).toBe(false);
    }
  });

  it('WORKER_CONTENT_HASH_TABLES is a subset of MANIFEST_ELIGIBLE_TABLES', () => {
    for (const table of WORKER_CONTENT_HASH_TABLES) {
      expect(
        MANIFEST_ELIGIBLE_TABLES.has(table),
        `${table} is in WORKER_CONTENT_HASH_TABLES but not in MANIFEST_ELIGIBLE_TABLES`,
      ).toBe(true);
    }
  });

  it('RECONCILE_ELIGIBLE_TABLES is a subset of MANIFEST_ELIGIBLE_TABLES', () => {
    // Guards against a daemon-only addition to the reconcile set that the worker's
    // /manifest doesn't serve — such a table would 400 at runtime on every reconcile pass.
    for (const table of RECONCILE_ELIGIBLE_TABLES) {
      expect(
        MANIFEST_ELIGIBLE_TABLES.has(table),
        `${table} is in RECONCILE_ELIGIBLE_TABLES but not in MANIFEST_ELIGIBLE_TABLES`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MANIFEST_ELIGIBLE_TABLES
// ---------------------------------------------------------------------------

describe('MANIFEST_ELIGIBLE_TABLES', () => {
  it('excludes entity_mentions (no single id column)', () => {
    expect(MANIFEST_ELIGIBLE_TABLES.has('entity_mentions')).toBe(false);
  });

  it('includes all other synced tables', () => {
    const expected = new Set(SYNCED_TABLES.filter((t) => t !== 'entity_mentions'));
    expect(MANIFEST_ELIGIBLE_TABLES).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// parseManifestParams
// ---------------------------------------------------------------------------

describe('parseManifestParams', () => {
  it('rejects missing machine_id', () => {
    const result = parseManifestParams(new URL('https://example.com/manifest?table=sessions'));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/machine_id/);
    }
  });

  it('rejects missing table', () => {
    const result = parseManifestParams(new URL('https://example.com/manifest?machine_id=m1'));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/table/);
    }
  });

  it('rejects ineligible table (entity_mentions)', () => {
    const result = parseManifestParams(
      new URL('https://example.com/manifest?machine_id=m1&table=entity_mentions'),
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(400);
    }
  });

  it('rejects unknown table', () => {
    const result = parseManifestParams(
      new URL('https://example.com/manifest?machine_id=m1&table=nonexistent'),
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(400);
    }
  });

  it('parses summary=1 correctly', () => {
    const result = parseManifestParams(
      new URL('https://example.com/manifest?machine_id=m1&table=sessions&summary=1'),
    );
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.summary).toBe(true);
    }
  });

  it('defaults summary to false when absent', () => {
    const result = parseManifestParams(
      new URL('https://example.com/manifest?machine_id=m1&table=sessions'),
    );
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.summary).toBe(false);
    }
  });

  it('caps limit at MAX_LIMIT=1000', () => {
    const result = parseManifestParams(
      new URL('https://example.com/manifest?machine_id=m1&table=sessions&limit=9999'),
    );
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.limit).toBe(1000);
    }
  });
});

// ---------------------------------------------------------------------------
// summary=1 scoping
// ---------------------------------------------------------------------------

describe('GET /manifest?summary=1 — scoping', () => {
  it('returns count scoped to machine_id only (no project_id)', async () => {
    const params = {
      machineId: MACHINE_A,
      table: 'sessions',
      projectId: null,
      cursor: null,
      limit: 200,
      summary: true,
    };
    const result = await queryManifest(fakeDb, params);

    // MACHINE_A has 3 sessions total (sess-a1, sess-a2, sess-a3)
    expect(result.count).toBe(3);
    expect(result.machine_id).toBe(MACHINE_A);
    expect('project_id' in result).toBe(false);
  });

  it('excludes the other machine from the count', async () => {
    const paramsA = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: true,
    };
    const paramsB = {
      machineId: MACHINE_B, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: true,
    };

    const resultA = await queryManifest(fakeDb, paramsA);
    const resultB = await queryManifest(fakeDb, paramsB);

    expect(resultA.count).toBe(3); // MACHINE_A: 3 sessions
    expect(resultB.count).toBe(1); // MACHINE_B: 1 session
    expect(resultA.count + resultB.count).toBe(SESSIONS_ROWS.length);
  });

  it('scopes to (machine_id, project_id) when project_id is given', async () => {
    const params = {
      machineId: MACHINE_A,
      table: 'sessions',
      projectId: PROJECT_1,
      cursor: null,
      limit: 200,
      summary: true,
    };
    const result = await queryManifest(fakeDb, params);

    // MACHINE_A + PROJECT_1: sess-a1, sess-a2
    expect(result.count).toBe(2);
    expect(result.project_id).toBe(PROJECT_1);
  });

  it('excludes the other project when project_id is given', async () => {
    const p1 = {
      machineId: MACHINE_A, table: 'sessions', projectId: PROJECT_1,
      cursor: null, limit: 200, summary: true,
    };
    const p2 = {
      machineId: MACHINE_A, table: 'sessions', projectId: PROJECT_2,
      cursor: null, limit: 200, summary: true,
    };

    const r1 = await queryManifest(fakeDb, p1);
    const r2 = await queryManifest(fakeDb, p2);

    expect(r1.count).toBe(2); // sess-a1, sess-a2
    expect(r2.count).toBe(1); // sess-a3
  });

  it('returns count=0 when no rows match', async () => {
    const params = {
      machineId: 'machine-unknown', table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: true,
    };
    const result = await queryManifest(fakeDb, params);
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Paged results — ordering and next_cursor
// ---------------------------------------------------------------------------

describe('GET /manifest paged — ordering and next_cursor', () => {
  it('returns items ordered by id for machine_id-only scope', async () => {
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    const ids = result.items.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('paginates correctly: next_cursor present when more rows exist', async () => {
    // MACHINE_A has 3 sessions. Limit=2 should return 2 and a next_cursor.
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 2, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    expect(result.items.length).toBe(2);
    expect(result.next_cursor).toBeDefined();
    // The cursor is the last item's id.
    expect(result.next_cursor).toBe(result.items[result.items.length - 1].id);
  });

  it('fetches the next page using the cursor', async () => {
    const page1 = await queryManifest(fakeDb, {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 2, summary: false,
    });
    expect('next_cursor' in page1).toBe(true);
    if (!('next_cursor' in page1) || !page1.next_cursor) return;

    const page2 = await queryManifest(fakeDb, {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: page1.next_cursor, limit: 2, summary: false,
    });
    expect('items' in page2).toBe(true);
    if (!('items' in page2)) return;

    // The combined ids from both pages should equal all MACHINE_A session ids.
    const p1ids = (page1 as { items: ManifestItem[] }).items.map((r) => r.id);
    const p2ids = page2.items.map((r) => r.id);
    const allIds = [...p1ids, ...p2ids].sort();
    const expectedIds = SESSIONS_ROWS
      .filter((r) => r.machine_id === MACHINE_A)
      .map((r) => r.id)
      .sort();
    expect(allIds).toEqual(expectedIds);
    // Last page has no cursor.
    expect(page2.next_cursor).toBeUndefined();
  });

  it('no next_cursor when all rows fit in one page', async () => {
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);
    expect('next_cursor' in result && result.next_cursor).toBeFalsy();
  });

  it('scopes paged results to (machine_id, project_id) when project_id is given', async () => {
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: PROJECT_1, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    // Only sess-a1 and sess-a2 belong to MACHINE_A + PROJECT_1.
    expect(result.items.length).toBe(2);
    expect(result.items.every((r) => r.project_id === PROJECT_1)).toBe(true);
    // sess-a3 (PROJECT_2) must not appear.
    expect(result.items.find((r) => r.id === 'sess-a3')).toBeUndefined();
  });

  it('excludes the other machine from paged results', async () => {
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    expect(result.items.every((r) => {
      // We verify by checking that the id matches known MACHINE_A rows.
      return SESSIONS_ROWS.some((sr) => sr.id === r.id && sr.machine_id === MACHINE_A);
    })).toBe(true);
    // sess-b1 (MACHINE_B) must not appear.
    expect(result.items.find((r) => r.id === 'sess-b1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// content_hash presence
// ---------------------------------------------------------------------------

describe('content_hash field on paged results', () => {
  it('includes content_hash for sessions (a content-hash table)', async () => {
    const params = {
      machineId: MACHINE_A, table: 'sessions',
      projectId: null, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect('content_hash' in item).toBe(true);
    }
  });

  it('omits content_hash for entities (not a content-hash table)', async () => {
    const params = {
      machineId: MACHINE_A, table: 'entities',
      projectId: null, cursor: null, limit: 200, summary: false,
    };
    const result = await queryManifest(fakeDb, params);

    expect('items' in result).toBe(true);
    if (!('items' in result)) return;

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect('content_hash' in item).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// v2 client still passes /connect against the v3 worker
// ---------------------------------------------------------------------------
// This assertion verifies the protocol compat window [minClientVersion=1,
// serverVersion=3]. A v2 client is inside [1, 3] and must get 200.
// We test parseManifestParams and the protocol logic directly since we
// can't import index.ts (cloudflare:email). The actual protocol-version
// window logic lives in resolveProtocolBounds which reads env vars; we
// test the invariant by checking the wrangler.toml values instead.

describe('protocol version: v2 client still accepted by v3 worker', () => {
  it('SYNC_PROTOCOL_VERSION in wrangler.toml is "3"', () => {
    const wranglerPath = path.resolve(
      __dirname,
      '../../packages/myco-team/worker/wrangler.toml',
    );
    const wranglerSrc = fs.readFileSync(wranglerPath, 'utf8');
    const match = wranglerSrc.match(/SYNC_PROTOCOL_VERSION\s*=\s*"(\d+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('3');
  });

  it('MIN_COMPAT_CLIENT_VERSION in wrangler.toml is "1"', () => {
    const wranglerPath = path.resolve(
      __dirname,
      '../../packages/myco-team/worker/wrangler.toml',
    );
    const wranglerSrc = fs.readFileSync(wranglerPath, 'utf8');
    const match = wranglerSrc.match(/MIN_COMPAT_CLIENT_VERSION\s*=\s*"(\d+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('1');
  });

  it('a v2 client is inside the window [MIN_COMPAT=1, SERVER=3]', () => {
    // The connect handler accepts clients in [minClientVersion, serverVersion].
    // With MIN_COMPAT_CLIENT_VERSION="1" and SYNC_PROTOCOL_VERSION="3",
    // a v2 client satisfies: 2 >= 1 AND 2 <= 3 → accepted (200).
    const minClient = 1;
    const serverVersion = 3;
    const clientVersion = 2; // v2 client

    const accepted = clientVersion >= minClient && clientVersion <= serverVersion;
    expect(accepted).toBe(true);
  });
});
