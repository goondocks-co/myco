/**
 * Spores server-side, and the three properties 1.4 encodes that a translation
 * drops silently: the terminal-session gate, supersession lineage read from
 * resolution events alone, and a status change committed with its event.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  countSpores, getSpore, insertSpore, listSpores, listSupersedingSporeIds, resolveSpore,
  type SporeInsert,
} from '@myco-server-worker/core/spores.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

/** A session with `ended_at` set is terminal; without it the session is still in flight. */
function seedSession(sqlite: Database, id: string, ended: boolean, projectId = SCOPE.projectId): void {
  sqlite.query(`INSERT INTO sessions (project_id, session_id, created_by_token_id, first_received_at, last_received_at, ended_at)
    VALUES (?, ?, 'tok', ?, ?, ?)`).run(projectId, id, NOW, NOW, ended ? NOW : null);
}

const spore = (id: string, over: Partial<SporeInsert> = {}): SporeInsert => ({
  id, agentId: AGENT, sessionId: null, promptId: null, observationType: 'gotcha',
  content: `content of ${id}`, context: null, filePath: null, tags: null,
  contentHash: null, properties: null, createdAt: NOW, ...over,
});

describe('spores', () => {
  it('returns the written row from the write, without reading it back', async () => {
    const { db } = store();
    const written = await insertSpore(db, SCOPE, spore('sp1'));
    expect({ id: written?.id, status: written?.status, importance: written?.importance, embedded: written?.embedded })
      .toEqual({ id: 'sp1', status: 'active', importance: 5, embedded: 0 });
  });

  it('keeps spores within their Project', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await getSpore(db, SCOPE, 'sp1')).not.toBeNull();
    expect(await getSpore(db, OTHER, 'sp1')).toBeNull();
    expect(await listSpores(db, OTHER)).toEqual([]);
  });

  it('filters by type, status and search, and counts what it lists', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1', { observationType: 'gotcha' }));
    await insertSpore(db, SCOPE, spore('sp2', { observationType: 'decision' }));
    expect((await listSpores(db, SCOPE, { observationType: 'decision' })).map((s) => s.id)).toEqual(['sp2']);
    expect(await countSpores(db, SCOPE, { observationType: 'decision' })).toBe(1);
    expect((await listSpores(db, SCOPE, { search: 'of sp1' })).map((s) => s.id)).toEqual(['sp1']);
  });
});

describe('the terminal-session gate', () => {
  it('hides a spore whose session is still in flight when a task asks for settled knowledge', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_open', false);
    seedSession(sqlite, 'sess_done', true);
    await insertSpore(db, SCOPE, spore('open', { sessionId: 'sess_open' }));
    await insertSpore(db, SCOPE, spore('done', { sessionId: 'sess_done' }));
    await insertSpore(db, SCOPE, spore('loose'));

    expect((await listSpores(db, SCOPE, { includeActive: false })).map((s) => s.id).sort()).toEqual(['done', 'loose']);
    expect(await countSpores(db, SCOPE, { includeActive: false })).toBe(2);
  });

  it('shows everything when the gate is not asked for, which is what the UI and hooks do', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_open', false);
    await insertSpore(db, SCOPE, spore('open', { sessionId: 'sess_open' }));
    expect((await listSpores(db, SCOPE)).map((s) => s.id)).toEqual(['open']);
  });

  it('never gates a direct session lookup, however open that session is', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_open', false);
    await insertSpore(db, SCOPE, spore('open', { sessionId: 'sess_open' }));
    expect((await listSpores(db, SCOPE, { includeActive: false, sessionId: 'sess_open' })).map((s) => s.id)).toEqual(['open']);
  });

  it('reads the session in this Project, not one of the same name elsewhere', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_x', false, SCOPE.projectId);
    seedSession(sqlite, 'sess_x', true, OTHER.projectId);
    await insertSpore(db, SCOPE, spore('here', { sessionId: 'sess_x' }));
    // This Project's session is open, so the gate hides it — the other Project's
    // ended session of the same name must not answer for it.
    expect(await listSpores(db, SCOPE, { includeActive: false })).toEqual([]);
  });
});

describe('resolution', () => {
  const event = (id: string, sporeId: string, over: Record<string, unknown> = {}) => ({
    id, agentId: AGENT, sporeId, action: 'supersede' as const,
    newSporeId: 'sp2', reason: null, sessionId: null, createdAt: NOW, ...over,
  });

  it('moves the status and records the event as one write', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await resolveSpore(db, SCOPE, 'superseded', event('re1', 'sp1'), NOW + 1)).toBe(true);
    expect((await getSpore(db, SCOPE, 'sp1'))?.status).toBe('superseded');
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(1);
  });

  it('writes neither half for a spore outside the scope', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await resolveSpore(db, OTHER, 'superseded', event('re1', 'sp1'), NOW + 1)).toBe(false);
    expect((await getSpore(db, SCOPE, 'sp1'))?.status).toBe('active');
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(0);
  });

  it('reads supersession lineage from resolution events, newest first', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    await resolveSpore(db, SCOPE, 'superseded', event('re1', 'sp1', { newSporeId: 'first', createdAt: NOW }), NOW);
    await resolveSpore(db, SCOPE, 'superseded', event('re2', 'sp1', { newSporeId: 'second', createdAt: NOW + 10 }), NOW + 10);
    expect(await listSupersedingSporeIds(db, SCOPE, 'sp1')).toEqual(['second', 'first']);
  });

  it('reports no lineage for a spore in another Project', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    await resolveSpore(db, SCOPE, 'superseded', event('re1', 'sp1'), NOW);
    expect(await listSupersedingSporeIds(db, OTHER, 'sp1')).toEqual([]);
  });

  it('counts a consolidation as lineage only under its own action', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    await resolveSpore(db, SCOPE, 'consolidated', event('re1', 'sp1', { action: 'consolidate', newSporeId: 'wisdom' }), NOW);
    expect(await listSupersedingSporeIds(db, SCOPE, 'sp1')).toEqual([]);
  });
});
