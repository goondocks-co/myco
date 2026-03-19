import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MycoIndex } from '@myco/index/sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MycoIndex', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-idx-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates database with WAL mode', () => {
    const mode = index.getPragma('journal_mode');
    expect(mode).toBe('wal');
  });

  it('upserts and retrieves a note', () => {
    index.upsertNote({
      path: 'sessions/2026-03-12/session-abc.md',
      type: 'session',
      id: 'abc',
      title: 'Auth Session',
      content: 'Refactored JWT middleware',
      frontmatter: { type: 'session', id: 'abc', agent: 'claude-code', user: 'chris', started: '2026-03-12T09:00:00Z' },
      created: '2026-03-12T09:00:00Z',
    });

    const note = index.getNoteByPath('sessions/2026-03-12/session-abc.md');
    expect(note).toBeTruthy();
    expect(note!.type).toBe('session');
    expect(note!.title).toBe('Auth Session');
  });

  it('updates existing note on re-upsert', () => {
    const noteData = {
      path: 'plans/auth.md',
      type: 'plan',
      id: 'auth',
      title: 'Auth Plan',
      content: 'v1',
      frontmatter: { type: 'plan', id: 'auth', status: 'active', created: '2026-03-12T00:00:00Z' },
      created: '2026-03-12T00:00:00Z',
    };

    index.upsertNote(noteData);
    index.upsertNote({ ...noteData, content: 'v2', title: 'Auth Plan Updated' });

    const note = index.getNoteByPath('plans/auth.md');
    expect(note!.content).toBe('v2');
    expect(note!.title).toBe('Auth Plan Updated');
  });

  it('deletes a note', () => {
    index.upsertNote({
      path: 'spores/m.md', type: 'spore', id: 'm', title: 'Spore',
      content: 'test', frontmatter: {}, created: '2026-03-12T00:00:00Z',
    });
    index.deleteNote('spores/m.md');
    expect(index.getNoteByPath('spores/m.md')).toBeNull();
  });

  it('queries notes by type', () => {
    index.upsertNote({
      path: 'sessions/s1.md', type: 'session', id: 's1', title: 'S1',
      content: '', frontmatter: {}, created: '2026-03-12T00:00:00Z',
    });
    index.upsertNote({
      path: 'plans/p1.md', type: 'plan', id: 'p1', title: 'P1',
      content: '', frontmatter: {}, created: '2026-03-12T00:00:00Z',
    });

    const sessions = index.query({ type: 'session' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s1');
  });

  it('handles empty database gracefully', () => {
    const results = index.query({ type: 'session' });
    expect(results).toEqual([]);
    expect(index.getNoteByPath('nonexistent.md')).toBeNull();
  });

  it('filters notes by updatedSince', () => {
    // Insert two notes, then manually backdate the first one so we can
    // query with a known boundary between their updated_at values.
    index.upsertNote({
      path: 'sessions/early.md', type: 'session', id: 'early', title: 'Early',
      content: 'first', frontmatter: {}, created: '2026-01-01T00:00:00Z',
    });
    index.upsertNote({
      path: 'sessions/late.md', type: 'session', id: 'late', title: 'Late',
      content: 'second', frontmatter: {}, created: '2026-02-01T00:00:00Z',
    });

    // Backdate the early note so there is a known gap between the two updated_at values
    const EARLY_TS = '2026-01-01 00:00:00';
    const LATE_TS = '2026-02-01 00:00:00';
    const BOUNDARY_TS = '2026-01-15 00:00:00';
    index.getDb().prepare("UPDATE notes SET updated_at = ? WHERE id = 'early'").run(EARLY_TS);
    index.getDb().prepare("UPDATE notes SET updated_at = ? WHERE id = 'late'").run(LATE_TS);

    // Query with updatedSince = boundary: should return only the late note
    const results = index.query({ updatedSince: BOUNDARY_TS });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('late');

    // Query with updatedSince before both: should return both
    const all = index.query({ updatedSince: '2025-01-01 00:00:00' });
    expect(all).toHaveLength(2);

    // Query with a far-future timestamp — should return nothing
    const none = index.query({ updatedSince: '2099-01-01 00:00:00' });
    expect(none).toHaveLength(0);
  });
});
