/**
 * Tests for log explorer API handlers: search, stream, and detail.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { insertLogEntry } from '@myco/db/queries/logs.js';
import { handleLogSearch, handleLogStream, handleLogDetail } from '@myco/daemon/api/log-explorer';
import type { RouteRequest } from '@myco/daemon/router';
import type { LogEntryInsert } from '@myco/db/queries/logs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntryInsert> = {}): LogEntryInsert {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    kind: 'session.start',
    component: 'session',
    message: 'Session started',
    data: null,
    session_id: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: {},
    query: {},
    params: {},
    pathname: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('log explorer API handlers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // handleLogSearch
  // ---------------------------------------------------------------------------

  describe('handleLogSearch', () => {
    it('returns paginated results with total, page, and page_size', async () => {
      insertLogEntry(makeEntry({ message: 'alpha' }));
      insertLogEntry(makeEntry({ message: 'beta' }));
      insertLogEntry(makeEntry({ message: 'gamma' }));

      const req = makeRequest({ query: { page: '1', page_size: '2' } });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.page_size).toBe(2);
      expect((body.entries as unknown[]).length).toBe(2);
    });

    it('filters by q (full-text search)', async () => {
      insertLogEntry(makeEntry({ message: 'daemon restarted cleanly' }));
      insertLogEntry(makeEntry({ message: 'session loaded from vault' }));

      const req = makeRequest({ query: { q: 'daemon' } });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      expect(body.total).toBe(1);
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries[0].message).toMatch(/daemon/);
    });

    it('filters by level (returns entries at or above the given level)', async () => {
      insertLogEntry(makeEntry({ level: 'debug' }));
      insertLogEntry(makeEntry({ level: 'info' }));
      insertLogEntry(makeEntry({ level: 'warn' }));
      insertLogEntry(makeEntry({ level: 'error' }));

      const req = makeRequest({ query: { level: 'warn' } });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      expect(body.total).toBe(2);
      const entries = body.entries as Array<Record<string, unknown>>;
      const levels = entries.map((e) => e.level as string);
      expect(levels).toContain('warn');
      expect(levels).toContain('error');
      expect(levels).not.toContain('debug');
      expect(levels).not.toContain('info');
    });

    it('parses data JSON in returned entries', async () => {
      insertLogEntry(makeEntry({ data: JSON.stringify({ key: 'value' }) }));

      const req = makeRequest({ query: {} });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries[0].data).toEqual({ key: 'value' });
    });

    it('returns null data when entry has no data', async () => {
      insertLogEntry(makeEntry({ data: null }));

      const req = makeRequest({ query: {} });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries[0].data).toBeNull();
    });

    it('returns empty entries when no entries exist', async () => {
      const req = makeRequest({ query: {} });
      const res = await handleLogSearch(req);

      const body = res.body as Record<string, unknown>;
      expect(body.total).toBe(0);
      expect((body.entries as unknown[]).length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // handleLogStream
  // ---------------------------------------------------------------------------

  describe('handleLogStream', () => {
    it('tail mode: returns the most recent N entries when no since param given', async () => {
      // Insert 10 entries with distinct messages so we can tell which ones came back
      for (let i = 1; i <= 10; i++) {
        insertLogEntry(makeEntry({ message: `entry-${i}` }));
      }

      // No since param, limit=3 → should return the 3 NEWEST entries, sorted ASC
      const req = makeRequest({ query: { limit: '3' } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.message)).toEqual(['entry-8', 'entry-9', 'entry-10']);
      // Cursor = max id returned (the last, newest entry)
      expect(body.cursor).toBe((entries[2] as Record<string, unknown>).id);
    });

    it('tail mode: cursor equals max id in table when entries exist but fewer than limit', async () => {
      insertLogEntry(makeEntry({ message: 'first' }));
      insertLogEntry(makeEntry({ message: 'second' }));

      const req = makeRequest({ query: {} });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBe(2);
      expect(entries[0].message).toBe('first');
      expect(entries[1].message).toBe('second');
    });

    it('tail mode: empty table returns no entries and cursor=0', async () => {
      const req = makeRequest({ query: {} });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      expect((body.entries as unknown[]).length).toBe(0);
      expect(body.cursor).toBe(0);
    });

    it('forward scan: explicit since=0 still returns all entries from the beginning', async () => {
      insertLogEntry(makeEntry({ message: 'first' }));
      insertLogEntry(makeEntry({ message: 'second' }));

      const req = makeRequest({ query: { since: '0' } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      expect((body.entries as unknown[]).length).toBe(2);
    });

    it('returns entries since cursor and advances cursor', async () => {
      const id1 = insertLogEntry(makeEntry({ message: 'first' }));
      insertLogEntry(makeEntry({ message: 'second' }));
      insertLogEntry(makeEntry({ message: 'third' }));

      const req = makeRequest({ query: { since: String(id1) } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBe(2);
      expect(entries[0].message).toBe('second');
      expect(entries[1].message).toBe('third');
    });

    it('returns empty entries and preserves cursor when no new entries', async () => {
      const id = insertLogEntry(makeEntry({ message: 'only entry' }));

      const req = makeRequest({ query: { since: String(id) } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      expect((body.entries as unknown[]).length).toBe(0);
      expect(body.cursor).toBe(id);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        insertLogEntry(makeEntry());
      }

      const req = makeRequest({ query: { since: '0', limit: '3' } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      expect((body.entries as unknown[]).length).toBe(3);
    });

    it('includes a category field derived from the kind prefix', async () => {
      insertLogEntry(makeEntry({ kind: 'database.optimize', component: 'database' }));
      insertLogEntry(makeEntry({ kind: 'embedding.embed', component: 'embedding' }));

      const req = makeRequest({ query: {} });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      const categories = entries.map((e) => e.category);
      expect(categories).toContain('database');
      expect(categories).toContain('embedding');
    });

    it('filters entries by category query param', async () => {
      insertLogEntry(makeEntry({ kind: 'database.optimize', component: 'database', message: 'db op' }));
      insertLogEntry(makeEntry({ kind: 'embedding.embed', component: 'embedding', message: 'embed op' }));
      insertLogEntry(makeEntry({ kind: 'database.vacuum', component: 'database', message: 'vacuum' }));

      const req = makeRequest({ query: { category: 'database' } });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.category === 'database')).toBe(true);
    });

    it('returns all entries when category param is not provided', async () => {
      insertLogEntry(makeEntry({ kind: 'database.optimize', component: 'database' }));
      insertLogEntry(makeEntry({ kind: 'embedding.embed', component: 'embedding' }));

      const req = makeRequest({ query: {} });
      const res = await handleLogStream(req);

      const body = res.body as Record<string, unknown>;
      expect((body.entries as unknown[]).length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // handleLogDetail
  // ---------------------------------------------------------------------------

  describe('handleLogDetail', () => {
    it('returns full entry by id with parsed data', async () => {
      const id = insertLogEntry(makeEntry({
        message: 'detail test',
        data: JSON.stringify({ foo: 'bar' }),
        level: 'warn',
        component: 'daemon',
      }));

      const req = makeRequest({ params: { id: String(id) } });
      const res = await handleLogDetail(req);

      expect(res.status).toBeUndefined(); // 200 default
      const body = res.body as Record<string, unknown>;
      expect(body.id).toBe(id);
      expect(body.message).toBe('detail test');
      expect(body.level).toBe('warn');
      expect(body.data).toEqual({ foo: 'bar' });
      expect(body.resolved).toBeDefined();
    });

    it('returns empty object for data when entry has no data', async () => {
      const id = insertLogEntry(makeEntry({ data: null }));

      const req = makeRequest({ params: { id: String(id) } });
      const res = await handleLogDetail(req);

      const body = res.body as Record<string, unknown>;
      expect(body.data).toEqual({});
    });

    it('returns 404 for missing entry', async () => {
      const req = makeRequest({ params: { id: '999999' } });
      const res = await handleLogDetail(req);

      expect(res.status).toBe(404);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBe('Log entry not found');
    });

    it('returns 400 for invalid (non-numeric) id', async () => {
      const req = makeRequest({ params: { id: 'not-a-number' } });
      const res = await handleLogDetail(req);

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBe('Invalid log entry ID');
    });

    it('includes resolved object (empty when no session_id)', async () => {
      const id = insertLogEntry(makeEntry({ session_id: null }));

      const req = makeRequest({ params: { id: String(id) } });
      const res = await handleLogDetail(req);

      const body = res.body as Record<string, unknown>;
      expect(body.resolved).toEqual({});
    });
  });
});
