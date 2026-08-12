import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { resolveWindow, WINDOW_PAD_SECONDS, MAX_EXPANSION_SECONDS } from '@myco/capture/diagnostics/window.js';

beforeEach(() => { setupTestDb(); cleanTestDb(); });
afterAll(() => teardownTestDb());

/**
 * Seed a minimal session row via the real query layer. `upsertSession`
 * requires `agent`/`created_at`; both are irrelevant to window resolution
 * so fixed filler values are used. `ended_at` is passed straight through
 * on the initial INSERT path (no ON CONFLICT involved for a fresh id), so
 * NULL (active session) round-trips correctly.
 */
function seedSessionRow(
  db: Database,
  seed: { id: string; started_at: number; ended_at: number | null },
): void {
  upsertSession({
    id: seed.id,
    agent: 'claude-code',
    started_at: seed.started_at,
    created_at: seed.started_at,
    ended_at: seed.ended_at,
  });
  void db;
}

describe('resolveWindow', () => {
  test('explicit window passes through', () => {
    expect(resolveWindow(getDatabase(), { since: 100, until: 200 })).toEqual({ since: 100, until: 200 });
  });

  test('session id pads ±30min and expands to overlapping sessions (duplicate pair)', () => {
    const db = getDatabase();
    // duplicate pair: B starts inside A's padded window and ends later
    seedSessionRow(db, { id: 'A', started_at: 10_000, ended_at: 10_600 });
    seedSessionRow(db, { id: 'B', started_at: 10_300, ended_at: 13_000 });
    const w = resolveWindow(db, { sessionId: 'A' });
    expect(w.since).toBe(10_000 - WINDOW_PAD_SECONDS);
    // single expansion pass: B overlaps, so the window extends past B's end
    expect(w.until).toBe(13_000 + WINDOW_PAD_SECONDS);
  });

  test('a long-lived ACTIVE session outside the padded span does not balloon the window', () => {
    const db = getDatabase();
    seedSessionRow(db, { id: 'A', started_at: 10_000, ended_at: 10_600 });
    // active session (ended_at NULL) started long before A — spans to "now"
    // and would overlap every window if expansion keyed on overlap alone
    seedSessionRow(db, { id: 'old-active', started_at: 5, ended_at: null });
    const w = resolveWindow(db, { sessionId: 'A' });
    expect(w.since).toBe(10_000 - WINDOW_PAD_SECONDS);
    expect(w.until).toBe(10_600 + WINDOW_PAD_SECONDS);
  });

  test('expansion is capped at MAX_EXPANSION_SECONDS beyond the initial span', () => {
    const db = getDatabase();
    seedSessionRow(db, { id: 'A', started_at: 100_000, ended_at: 100_600 });
    // starts inside A's padded span, ends 3 days later
    seedSessionRow(db, { id: 'marathon', started_at: 100_500, ended_at: 100_500 + 3 * 86_400 });
    const w = resolveWindow(db, { sessionId: 'A' });
    expect(w.until).toBe(100_600 + WINDOW_PAD_SECONDS + MAX_EXPANSION_SECONDS);
  });

  test('unknown session throws', () => {
    expect(() => resolveWindow(getDatabase(), { sessionId: 'nope' })).toThrow(/session not found/i);
  });
});
