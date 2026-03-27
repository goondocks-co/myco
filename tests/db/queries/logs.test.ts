/**
 * Tests for log entry CRUD query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  insertLogEntry,
  searchLogs,
  getLogsSince,
  getLogEntry,
  deleteOldLogs,
  getMaxTimestamp,
} from '@myco/db/queries/logs.js';
import type { LogEntryInsert } from '@myco/db/queries/logs.js';

/** Factory for a minimal valid log entry. */
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

/** Make a fixed ISO timestamp offset by `offsetMs` milliseconds. */
function ts(base: Date, offsetMs = 0): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}

describe('log query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // insertLogEntry
  // ---------------------------------------------------------------------------

  describe('insertLogEntry', () => {
    it('inserts a log entry and returns a positive integer id', () => {
      const id = insertLogEntry(makeEntry());
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('returns incrementing ids for successive inserts', () => {
      const id1 = insertLogEntry(makeEntry());
      const id2 = insertLogEntry(makeEntry());
      expect(id2).toBeGreaterThan(id1);
    });

    it('populates the FTS index so the entry is searchable', () => {
      insertLogEntry(makeEntry({ message: 'uniqueftstokenxyz' }));

      const db = getDatabase();
      const rows = db.prepare(
        `SELECT rowid FROM log_entries_fts WHERE log_entries_fts MATCH ?`,
      ).all('uniqueftstokenxyz') as { rowid: number }[];

      expect(rows).toHaveLength(1);
    });

    it('stores null data and null session_id correctly', () => {
      const id = insertLogEntry(makeEntry({ data: null, session_id: null }));
      const row = getLogEntry(id);
      expect(row).not.toBeNull();
      expect(row!.data).toBeNull();
      expect(row!.session_id).toBeNull();
    });

    it('stores non-null data and session_id correctly', () => {
      const id = insertLogEntry(makeEntry({
        data: JSON.stringify({ foo: 'bar' }),
        session_id: 'sess-abc',
      }));
      const row = getLogEntry(id);
      expect(row!.data).toBe('{"foo":"bar"}');
      expect(row!.session_id).toBe('sess-abc');
    });
  });

  // ---------------------------------------------------------------------------
  // getLogEntry
  // ---------------------------------------------------------------------------

  describe('getLogEntry', () => {
    it('returns the entry by id', () => {
      const id = insertLogEntry(makeEntry({ message: 'hello world', level: 'warn' }));
      const row = getLogEntry(id);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(id);
      expect(row!.message).toBe('hello world');
      expect(row!.level).toBe('warn');
    });

    it('returns null for a non-existent id', () => {
      const row = getLogEntry(999999);
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // searchLogs
  // ---------------------------------------------------------------------------

  describe('searchLogs', () => {
    it('returns all entries when no filters are applied', () => {
      insertLogEntry(makeEntry());
      insertLogEntry(makeEntry());
      insertLogEntry(makeEntry());

      const result = searchLogs({});
      expect(result.entries).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('orders results by timestamp DESC, id DESC', () => {
      const base = new Date('2024-01-01T00:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, 0) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 2000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 1000) }));

      const result = searchLogs({});
      const timestamps = result.entries.map((e) => e.timestamp);
      expect(timestamps[0]).toBe(ts(base, 2000));
      expect(timestamps[1]).toBe(ts(base, 1000));
      expect(timestamps[2]).toBe(ts(base, 0));
    });

    it('filters by exact level', () => {
      insertLogEntry(makeEntry({ level: 'debug' }));
      insertLogEntry(makeEntry({ level: 'info' }));
      insertLogEntry(makeEntry({ level: 'warn' }));
      insertLogEntry(makeEntry({ level: 'error' }));

      const result = searchLogs({ level: 'error' });
      expect(result.total).toBe(1);
      expect(result.entries[0].level).toBe('error');
    });

    it('level filter includes all levels at or above minimum', () => {
      insertLogEntry(makeEntry({ level: 'debug' }));
      insertLogEntry(makeEntry({ level: 'info' }));
      insertLogEntry(makeEntry({ level: 'warn' }));
      insertLogEntry(makeEntry({ level: 'error' }));

      const result = searchLogs({ level: 'warn' });
      expect(result.total).toBe(2);
      const levels = result.entries.map((e) => e.level).sort();
      expect(levels).toContain('warn');
      expect(levels).toContain('error');
      expect(levels).not.toContain('debug');
      expect(levels).not.toContain('info');
    });

    it('filters by single component', () => {
      insertLogEntry(makeEntry({ component: 'session' }));
      insertLogEntry(makeEntry({ component: 'daemon' }));
      insertLogEntry(makeEntry({ component: 'daemon' }));

      const result = searchLogs({ component: 'daemon' });
      expect(result.total).toBe(2);
      for (const entry of result.entries) {
        expect(entry.component).toBe('daemon');
      }
    });

    it('filters by comma-separated component list', () => {
      insertLogEntry(makeEntry({ component: 'session' }));
      insertLogEntry(makeEntry({ component: 'daemon' }));
      insertLogEntry(makeEntry({ component: 'agent' }));
      insertLogEntry(makeEntry({ component: 'index' }));

      const result = searchLogs({ component: 'session,daemon' });
      expect(result.total).toBe(2);
      const components = result.entries.map((e) => e.component);
      expect(components).toContain('session');
      expect(components).toContain('daemon');
      expect(components).not.toContain('agent');
    });

    it('filters by kind', () => {
      insertLogEntry(makeEntry({ kind: 'session.start' }));
      insertLogEntry(makeEntry({ kind: 'session.stop' }));
      insertLogEntry(makeEntry({ kind: 'session.start' }));

      const result = searchLogs({ kind: 'session.start' });
      expect(result.total).toBe(2);
      for (const entry of result.entries) {
        expect(entry.kind).toBe('session.start');
      }
    });

    it('filters by session_id', () => {
      insertLogEntry(makeEntry({ session_id: 'sess-aaa' }));
      insertLogEntry(makeEntry({ session_id: 'sess-bbb' }));
      insertLogEntry(makeEntry({ session_id: 'sess-aaa' }));
      insertLogEntry(makeEntry({ session_id: null }));

      const result = searchLogs({ session_id: 'sess-aaa' });
      expect(result.total).toBe(2);
      for (const entry of result.entries) {
        expect(entry.session_id).toBe('sess-aaa');
      }
    });

    it('filters by time range (from)', () => {
      const base = new Date('2024-06-01T00:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, -2000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 0) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 2000) }));

      const result = searchLogs({ from: base.toISOString() });
      expect(result.total).toBe(2);
    });

    it('filters by time range (to)', () => {
      const base = new Date('2024-06-01T00:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, -2000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 0) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 2000) }));

      const result = searchLogs({ to: base.toISOString() });
      expect(result.total).toBe(2);
    });

    it('filters by time range (from + to)', () => {
      const base = new Date('2024-06-01T00:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, -5000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 0) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 3000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 10000) }));

      const result = searchLogs({
        from: ts(base, -1000),
        to: ts(base, 5000),
      });
      expect(result.total).toBe(2);
    });

    it('filters by full-text search query', () => {
      insertLogEntry(makeEntry({ message: 'daemon started successfully' }));
      insertLogEntry(makeEntry({ message: 'session resumed after reload' }));
      insertLogEntry(makeEntry({ message: 'daemon stopped' }));

      const result = searchLogs({ q: 'daemon' });
      expect(result.total).toBe(2);
      for (const entry of result.entries) {
        expect(entry.message).toMatch(/daemon/);
      }
    });

    it('combines multiple filters', () => {
      insertLogEntry(makeEntry({ level: 'error', component: 'daemon', kind: 'session.start' }));
      insertLogEntry(makeEntry({ level: 'warn', component: 'daemon', kind: 'session.stop' }));
      insertLogEntry(makeEntry({ level: 'error', component: 'agent', kind: 'session.start' }));

      const result = searchLogs({ level: 'warn', component: 'daemon' });
      // warn + error for daemon = 2 entries
      expect(result.total).toBe(2);
      for (const entry of result.entries) {
        expect(entry.component).toBe('daemon');
      }
    });

    it('paginates with page and page_size', () => {
      for (let i = 0; i < 10; i++) {
        insertLogEntry(makeEntry());
      }

      const page1 = searchLogs({ page: 1, page_size: 4 });
      const page2 = searchLogs({ page: 2, page_size: 4 });
      const page3 = searchLogs({ page: 3, page_size: 4 });

      expect(page1.entries).toHaveLength(4);
      expect(page1.total).toBe(10);
      expect(page1.page).toBe(1);
      expect(page1.page_size).toBe(4);

      expect(page2.entries).toHaveLength(4);
      expect(page2.page).toBe(2);

      expect(page3.entries).toHaveLength(2);
      expect(page3.page).toBe(3);

      // Pages must be distinct
      const ids1 = new Set(page1.entries.map((e) => e.id));
      for (const entry of page2.entries) {
        expect(ids1.has(entry.id)).toBe(false);
      }
    });

    it('returns empty entries with correct total when page exceeds results', () => {
      insertLogEntry(makeEntry());

      const result = searchLogs({ page: 99, page_size: 10 });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(1);
    });

    it('returns empty result when no entries match filters', () => {
      insertLogEntry(makeEntry({ level: 'info' }));

      const result = searchLogs({ level: 'error' });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getLogsSince
  // ---------------------------------------------------------------------------

  describe('getLogsSince', () => {
    it('returns entries with id > sinceId in ascending order', () => {
      const id1 = insertLogEntry(makeEntry({ message: 'first' }));
      const id2 = insertLogEntry(makeEntry({ message: 'second' }));
      const id3 = insertLogEntry(makeEntry({ message: 'third' }));

      const result = getLogsSince(id1);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].id).toBe(id2);
      expect(result.entries[1].id).toBe(id3);
    });

    it('returns cursor equal to the last entry id', () => {
      insertLogEntry(makeEntry());
      const id2 = insertLogEntry(makeEntry());
      const id3 = insertLogEntry(makeEntry());

      const result = getLogsSince(id2);
      expect(result.cursor).toBe(id3);
    });

    it('returns empty entries and preserves sinceId as cursor when no new entries', () => {
      const id = insertLogEntry(makeEntry());

      const result = getLogsSince(id);
      expect(result.entries).toHaveLength(0);
      expect(result.cursor).toBe(id);
    });

    it('returns all entries when sinceId is 0', () => {
      insertLogEntry(makeEntry());
      insertLogEntry(makeEntry());
      insertLogEntry(makeEntry());

      const result = getLogsSince(0);
      expect(result.entries).toHaveLength(3);
    });

    it('respects the optional limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        insertLogEntry(makeEntry());
      }

      const result = getLogsSince(0, 5);
      expect(result.entries).toHaveLength(5);
    });

    it('returns entries in ascending id order', () => {
      const ids = [
        insertLogEntry(makeEntry()),
        insertLogEntry(makeEntry()),
        insertLogEntry(makeEntry()),
      ];

      const result = getLogsSince(0);
      const resultIds = result.entries.map((e) => e.id);
      expect(resultIds).toEqual(ids);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteOldLogs
  // ---------------------------------------------------------------------------

  describe('deleteOldLogs', () => {
    it('deletes entries older than the given timestamp', () => {
      const base = new Date('2024-01-15T12:00:00.000Z');

      insertLogEntry(makeEntry({ timestamp: ts(base, -10000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, -5000) }));
      const keepId = insertLogEntry(makeEntry({ timestamp: ts(base, 1000) }));

      const deleted = deleteOldLogs(base.toISOString());
      expect(deleted).toBe(2);

      // Kept entry should still exist
      expect(getLogEntry(keepId)).not.toBeNull();
    });

    it('returns 0 when no entries are older than the cutoff', () => {
      const base = new Date('2024-01-15T12:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, 5000) }));

      const deleted = deleteOldLogs(ts(base, -1000));
      expect(deleted).toBe(0);
    });

    it('removes deleted entries from the FTS index', () => {
      const db = getDatabase();
      const base = new Date('2024-01-15T12:00:00.000Z');

      const id = insertLogEntry(makeEntry({
        timestamp: ts(base, -5000),
        message: 'uniquedeletetokenabc',
      }));

      // Confirm it's in the FTS index before deletion
      const before = db.prepare(
        `SELECT rowid FROM log_entries_fts WHERE log_entries_fts MATCH ?`,
      ).all('uniquedeletetokenabc') as { rowid: number }[];
      expect(before).toHaveLength(1);

      deleteOldLogs(base.toISOString());

      // Should be gone from FTS
      const after = db.prepare(
        `SELECT rowid FROM log_entries_fts WHERE log_entries_fts MATCH ?`,
      ).all('uniquedeletetokenabc') as { rowid: number }[];
      expect(after).toHaveLength(0);

      // And gone from the main table
      expect(getLogEntry(id)).toBeNull();
    });

    it('does not delete entries at or after the cutoff timestamp', () => {
      const cutoff = '2024-06-01T00:00:00.000Z';
      insertLogEntry(makeEntry({ timestamp: cutoff }));
      insertLogEntry(makeEntry({ timestamp: '2024-06-01T01:00:00.000Z' }));

      const deleted = deleteOldLogs(cutoff);
      expect(deleted).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getMaxTimestamp
  // ---------------------------------------------------------------------------

  describe('getMaxTimestamp', () => {
    it('returns null when the table is empty', () => {
      expect(getMaxTimestamp()).toBeNull();
    });

    it('returns the maximum timestamp when entries exist', () => {
      const base = new Date('2024-06-01T00:00:00.000Z');
      insertLogEntry(makeEntry({ timestamp: ts(base, 0) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 5000) }));
      insertLogEntry(makeEntry({ timestamp: ts(base, 1000) }));

      expect(getMaxTimestamp()).toBe(ts(base, 5000));
    });
  });
});
