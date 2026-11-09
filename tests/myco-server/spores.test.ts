/**
 * Spores server-side, and the three properties 1.4 encodes that a translation
 * drops silently: the terminal-session gate, supersession lineage read from
 * resolution events alone, and a status change committed with its event.
 */
import { describe, expect, it } from 'bun:test';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { Database } from 'bun:sqlite';
import { seededSqlite } from './helpers/d1.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { listSporePage, type ListSporesOptions, type SporeInsert } from '@myco-server-worker/core/spores.js';
import { consolidateSpores, resolveSpore } from '@myco-server-worker/db/spores/lifecycle.js';
import { getSpore, insertSpore, repairImportedSporeSource } from '@myco-server-worker/db/spores/records.js';
import { listSupersededSporeIds, listSupersedingSporeIds } from '@myco-server-worker/db/spores/edges.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
/** The ids one page of the list holds. */
const listed = async (db: RelationalStore, scope: ReadScope, o: ListSporesOptions = {}) => (await listSporePage(db, scope, o))!.rows.map((s) => s.id);
/** An edit as a writer of a spore's body makes one: the body changes and the revision moves. */
const edit = (db: RelationalStore, id: string, content: string) => db.prepare(`UPDATE spores SET content = ?, revision = revision + 1, updated_at = ?
  WHERE project_id = ? AND id = ? AND content <> ?`).bind(content, NOW, SCOPE.projectId, id, content).run();

function seededStore(): { db: RelationalStore; sqlite: Database } {
  const sqlite = seededSqlite();
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
  id, agentId: AGENT, sessionId: null, observationType: 'gotcha',
  content: `content of ${id}`, context: null, filePath: null, tags: null,
  contentHash: null, properties: null, author: null, createdAt: NOW, ...over,
});

const store = seededStore;
const catchUpPhaseDone = async (db: RelationalStore): Promise<number> => { await catchUpPhase(db, 'sporeResolutionEdges'); return (await db.prepare("SELECT done FROM projection_catchup WHERE projection = 'spore_resolution_edges'").first<{ done: number }>())!.done; };

describe('spores', () => {
  it('stores no prompt on direct saves, consolidation or import source repair, and reads legacy citations by session', async () => {
    const { db, sqlite } = store();
    try {
      seedSession(sqlite, 'source', true);
      const input = spore('direct', { sessionId: 'source' });
      await insertSpore(db, SCOPE, input);
      const event = { agentId: AGENT, author: null, reason: 'combined', sessionId: 'source', createdAt: NOW };
      await consolidateSpores(db, SCOPE, { wisdom: { ...input, id: 'wisdom' }, sources: [{ id: 'direct' }], event: event, now: NOW });
      await insertSpore(db, SCOPE, spore('imported', { author: 'member' }));
      await repairImportedSporeSource(db, SCOPE, { id: 'imported', author: 'member', agentId: AGENT, content: 'content of imported', sessionId: 'source' });
      expect(sqlite.query('SELECT DISTINCT prompt_id FROM spores').all()).toEqual([{ prompt_id: null }]);
      sqlite.run("UPDATE spores SET prompt_id='old-prompt' WHERE id='direct'");
      const read = await getSpore(db, SCOPE, 'direct');
      expect(read).toMatchObject({ sessionId: 'source', sourceCreatedAt: NOW });
      expect(read).not.toHaveProperty('promptId');
      expect(sqlite.query("SELECT prompt_id FROM spores WHERE id='direct'").get()).toEqual({ prompt_id: 'old-prompt' });
    } finally { sqlite.close(); }
  });

  it('returns the written row from the write, without reading it back', async () => {
    const { db } = store();
    const written = await insertSpore(db, SCOPE, spore('sp1'));
    expect({ id: written?.id, status: written?.status, importance: written?.importance, embedded: written?.embedded })
      .toEqual({ id: 'sp1', status: 'active', importance: 5, embedded: 0 });
  });

  it('refuses a spore naming a session no table holds, which is what the pragma buys', async () => {
    const { db } = store();
    await expect(insertSpore(db, SCOPE, spore('sp1', { sessionId: 'sess_nowhere' }))).rejects.toThrow();
  });

  it('holds one order over a page boundary when two spores share an instant', async () => {
    const { db } = store();
    for (const id of ['sp_a', 'sp_b', 'sp_c']) await insertSpore(db, SCOPE, spore(id, { createdAt: NOW }));
    const first = (await listSporePage(db, SCOPE, { limit: 2 }))!;
    const second = (await listSporePage(db, SCOPE, { limit: 2, cursor: first.cursor! }))!;
    expect({ ids: [...first.rows, ...second.rows].map((s) => s.id), more: [first.hasMore, second.hasMore], end: second.cursor })
      .toEqual({ ids: ['sp_c', 'sp_b', 'sp_a'], more: [true, false], end: null });
  });

  it('keeps spores within their Project', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await getSpore(db, SCOPE, 'sp1')).not.toBeNull();
    expect(await getSpore(db, OTHER, 'sp1')).toBeNull();
    expect(await listed(db, OTHER)).toEqual([]);
  });

  it('filters by type and status, and totals what the filter admits from the counters', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1', { observationType: 'gotcha' }));
    await insertSpore(db, SCOPE, spore('sp2', { observationType: 'decision' }));
    const page = (await listSporePage(db, SCOPE, { observationType: 'decision', limit: 1 }))!;
    expect({ ids: page.rows.map((s) => s.id), total: page.total, hasMore: page.hasMore }).toEqual({ ids: ['sp2'], total: 1, hasMore: false });
    expect((await listSporePage(db, SCOPE, { status: 'active', limit: 1 }))).toMatchObject({ total: 2, hasMore: true });
  });

  it('carries no total for a list by agent or author, and refuses a cursor it did not issue', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await listSporePage(db, SCOPE, { agentId: AGENT })).toEqual({ rows: [expect.objectContaining({ id: 'sp1' })], cursor: null, hasMore: false });
    expect(await listSporePage(db, SCOPE, { cursor: 'not-a-cursor' })).toBeNull();
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

    expect((await listed(db, SCOPE, { includeActive: false })).sort()).toEqual(['done', 'loose']);
    expect((await listSporePage(db, SCOPE, { includeActive: false }))!.total).toBeUndefined();
  });

  it('shows everything when the gate is not asked for, which is what the UI and hooks do', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_open', false);
    await insertSpore(db, SCOPE, spore('open', { sessionId: 'sess_open' }));
    expect(await listed(db, SCOPE)).toEqual(['open']);
  });

  it('never gates a direct session lookup, however open that session is', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_open', false);
    await insertSpore(db, SCOPE, spore('open', { sessionId: 'sess_open' }));
    expect(await listed(db, SCOPE, { includeActive: false, sessionId: 'sess_open' })).toEqual(['open']);
    // The gate's bypass changes which rows a session read lists, not the contract: a list with the gate asked for has no total.
    expect(await listSporePage(db, SCOPE, { includeActive: false, sessionId: 'sess_open' })).toMatchObject({ hasMore: false });
    expect((await listSporePage(db, SCOPE, { includeActive: false, sessionId: 'sess_open' }))!.total).toBeUndefined();
    expect((await listSporePage(db, SCOPE, { sessionId: 'sess_open' }))!.total).toBe(1);
  });

  it('reads the session in this Project, not one of the same name elsewhere', async () => {
    const { db, sqlite } = store();
    seedSession(sqlite, 'sess_x', false, SCOPE.projectId);
    seedSession(sqlite, 'sess_x', true, OTHER.projectId);
    await insertSpore(db, SCOPE, spore('here', { sessionId: 'sess_x' }));
    // This Project's session is open, so the gate hides it — the other Project's
    // ended session of the same name must not answer for it.
    expect(await listed(db, SCOPE, { includeActive: false })).toEqual([]);
  });
});

describe('resolution', () => {
  /** A store holding every spore these resolutions name as a successor: lifecycle writes refuse a successor that is not active. */
  const store = () => {
    const held = seededStore();
    for (const id of ['sp2', 'first', 'second', 'new']) {
      held.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES (?, ?, ?, 'successor', 'gotcha', ?)`).run(SCOPE.projectId, id, AGENT, NOW);
    }
    return held;
  };
  const event = (id: string, sporeId: string, over: Record<string, unknown> = {}) => ({
    id, agentId: AGENT, sporeId, action: 'supersede' as const,
    newSporeId: 'sp2', reason: null, sessionId: null, author: null, createdAt: NOW, ...over,
  });

  it('moves the status and records the event as one write', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'sp1'), now: NOW + 1 })).toBe(true);
    expect((await getSpore(db, SCOPE, 'sp1'))?.status).toBe('superseded');
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(1);
  });

  it('writes neither half for a spore outside the scope', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    expect(await resolveSpore(db, OTHER, { status: 'superseded', event: event('re1', 'sp1'), now: NOW + 1 })).toBe(false);
    expect((await getSpore(db, SCOPE, 'sp1'))?.status).toBe('active');
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(0);
  });

  it('refuses a second independent resolution by name and records only the landed event', async () => {
    const { db, sqlite } = store();
    try {
      await insertSpore(db, SCOPE, spore('sp1'));
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'sp1', { newSporeId: 'first' }), now: NOW })).toBe(true);
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re2', 'sp1', { newSporeId: 'second' }), now: NOW }))
        .toEqual({ error: 'stale', status: 'superseded', revision: 1, reason: 'source is superseded at revision 1; expected active' });
      expect(await listSupersedingSporeIds(db, SCOPE, 'sp1')).toEqual(['first']);
      expect(sqlite.query('SELECT id FROM resolution_events').all()).toEqual([{ id: 're1' }]);
    } finally { sqlite.close(); }
  });

  it('status guard refuses a terminal source even with its current revision', async () => {
    const { db, sqlite } = store();
    try {
      await insertSpore(db, SCOPE, spore('sp1'));
      for (const text of ['one', 'two', 'three']) await edit(db, 'sp1', text);
      expect((await getSpore(db, SCOPE, 'sp1'))?.revision).toBe(3);
      await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'sp1'), now: NOW, expect: { revision: 3 } });
      expect(await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('re2', 'sp1'), action: 'obsolete' }, now: NOW, expect: { revision: 4 } }))
        .toEqual({ error: 'stale', status: 'superseded', revision: 4, reason: 'source is superseded at revision 4; expected active at revision 4' });
      expect(sqlite.query('SELECT id FROM resolution_events').all()).toEqual([{ id: 're1' }]);
    } finally { sqlite.close(); }
  });

  it('revision guard refuses an active source edited since the read', async () => {
    const { db, sqlite } = store();
    try {
      await insertSpore(db, SCOPE, spore('sp1'));
      for (const text of ['one', 'two', 'three']) await edit(db, 'sp1', text);
      const read = (await getSpore(db, SCOPE, 'sp1'))!;
      await edit(db, 'sp1', 'four');
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('stale-revision', 'sp1'), now: NOW, expect: { revision: read.revision } }))
        .toEqual({ error: 'stale', status: 'active', revision: 4, reason: 'source is active at revision 4; expected active at revision 3' });
      expect(sqlite.query('SELECT id FROM resolution_events').all()).toEqual([]);
      expect((await getSpore(db, SCOPE, 'sp1'))?.revision).toBe(4);
    } finally { sqlite.close(); }
  });

  it('editorial re-resolution requires an explicit matching terminal status and preserves lineage', async () => {
    const { db, sqlite } = store();
    try {
      await insertSpore(db, SCOPE, spore('sp1'));
      await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'sp1', { newSporeId: 'first' }), now: NOW });
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re2', 'sp1', { newSporeId: 'second', createdAt: NOW + 10 }), now: NOW, expect: { status: 'superseded', revision: 1 } })).toBe(true);
      expect(await listSupersedingSporeIds(db, SCOPE, 'sp1')).toEqual(['second', 'first']);
      expect((await getSpore(db, SCOPE, 'sp1'))?.revision).toBe(2);
      expect(await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('re3', 'sp1'), action: 'obsolete' }, now: NOW, expect: { status: 'obsolete' } }))
        .toEqual({ error: 'stale', status: 'superseded', revision: 2, reason: 'source is superseded at revision 2; expected obsolete' });
      expect(await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('re3', 'sp1'), action: 'obsolete' }, now: NOW, expect: { status: 'superseded' } })).toBe(true);
    } finally { sqlite.close(); }
  });

  it('consolidation moves every source or none, and names the first source that changed since it was read', async () => {
    const { db, sqlite } = store();
    try {
      for (const id of ['a', 'b', 'c']) await insertSpore(db, SCOPE, spore(id));
      await edit(db, 'b', 'edited');
      const sources = [{ id: 'a', revision: 0 }, { id: 'b', revision: 0 }, { id: 'c', revision: 0 }];
      const event = { agentId: AGENT, reason: null, sessionId: null, author: null, createdAt: NOW };
      expect(await consolidateSpores(db, SCOPE, { wisdom: spore('wisdom'), sources: sources, event: event, now: NOW }))
        .toEqual({ wisdom: null, consolidated: 0, stale: { id: 'b', status: 'active', revision: 1, expected: 0 } });
      expect({ wisdom: await getSpore(db, SCOPE, 'wisdom'), events: sqlite.query('SELECT id FROM resolution_events').all(),
        statuses: ['a', 'b', 'c'].map(id => sqlite.query('SELECT status, revision FROM spores WHERE id = ?').get(id)) })
        .toEqual({ wisdom: null, events: [], statuses: [{ status: 'active', revision: 0 }, { status: 'active', revision: 1 }, { status: 'active', revision: 0 }] });
      const merged = await consolidateSpores(db, SCOPE, { wisdom: spore('wisdom'), sources: [{ id: 'a', revision: 0 }, { id: 'b', revision: 1 }, { id: 'c', revision: 0 }], event: event, now: NOW });
      expect({ id: merged.wisdom?.id, consolidated: merged.consolidated }).toEqual({ id: 'wisdom', consolidated: 3 });
    } finally { sqlite.close(); }
  });

  it('rolls the status and revision back if the event cannot be stored', async () => {
    const { db, sqlite } = store();
    try {
      await insertSpore(db, SCOPE, spore('sp1'));
      await expect(resolveSpore(db, SCOPE, { status: 'superseded', event: { ...event('bad', 'sp1'), agentId: 'missing' }, now: NOW })).rejects.toThrow();
      expect(await getSpore(db, SCOPE, 'sp1')).toMatchObject({ status: 'active', revision: 0 });
      expect(sqlite.query('SELECT id FROM resolution_events').all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('reports no lineage for a spore in another Project', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'sp1'), now: NOW });
    expect(await listSupersedingSporeIds(db, OTHER, 'sp1')).toEqual([]);
  });

  it('counts a consolidation as lineage only under its own action', async () => {
    const { db } = store();
    for (const id of ['sp1', 'wisdom']) await insertSpore(db, SCOPE, spore(id));
    expect(await resolveSpore(db, SCOPE, { status: 'consolidated', event: event('re1', 'sp1', { action: 'consolidate', newSporeId: 'wisdom' }), now: NOW })).toBe(true);
    expect(await listSupersedingSporeIds(db, SCOPE, 'sp1')).toEqual([]);
  });

  it('reads the same events backwards: what a replacement grew out of, by supersede and by consolidate alike', async () => {
    const { db } = store();
    for (const id of ['old', 'merged', 'new']) await insertSpore(db, SCOPE, spore(id));
    await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'old', { newSporeId: 'new', createdAt: NOW }), now: NOW });
    await resolveSpore(db, SCOPE, { status: 'consolidated', event: event('re2', 'merged', { action: 'consolidate', newSporeId: 'new', createdAt: NOW + 10 }), now: NOW + 10 });
    expect(await listSupersededSporeIds(db, SCOPE, 'new')).toEqual(['merged', 'old']);
  });

  it('names no predecessor from another Project, and none for a retirement that replaced nothing', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('old'));
    await insertSpore(db, SCOPE, spore('new'));
    await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'old', { newSporeId: 'new' }), now: NOW });
    expect(await listSupersededSporeIds(db, OTHER, 'new')).toEqual([]);
    await insertSpore(db, SCOPE, spore('gone'));
    await resolveSpore(db, SCOPE, { status: 'obsolete', event: event('re2', 'gone', { action: 'obsolete', newSporeId: null }), now: NOW });
    expect(await listSupersededSporeIds(db, SCOPE, 'gone')).toEqual([]);
  });
});

/**
 * The consolidation path, executed rather than asserted.
 *
 * Its `resolution_events` INSERT carries a literal in the `action` position, so
 * its placeholder count and its column count differ by one and a miscount is
 * invisible to `tsc`. It is also the one write an External Agent grant never
 * reaches, so nothing else in the suite executes it with the columns two lanes
 * added. Reading the stored rows back is what makes those columns safe to add
 * from a hunk neither lane can verify by reading.
 */
describe('a lifecycle write, decided inside its commit', () => {
  const seeded = () => {
    const held = store();
    for (const id of ['source', 'keeper']) {
      held.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES (?, ?, ?, 'body', 'gotcha', ?)`).run(SCOPE.projectId, id, AGENT, NOW);
    }
    return held;
  };
  const event = (id: string, newSporeId: string | null, sporeId = 'source') => ({
    id, agentId: AGENT, sporeId, action: 'supersede' as const, newSporeId, reason: null, sessionId: null, author: null, createdAt: NOW,
  });

  it('refuses a successor that is absent, the source itself or no longer active, and moves nothing', async () => {
    const { db, sqlite } = seeded();
    try {
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('e1', 'ghost'), now: NOW })).toEqual({ error: 'successor', state: 'missing' });
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('e2', 'source'), now: NOW })).toEqual({ error: 'successor', state: 'self' });
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('e3', 'keeper', 'keeper'), now: NOW })).toEqual({ error: 'successor', state: 'self' });
      await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('e4', null, 'keeper'), action: 'obsolete' }, now: NOW });
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('e5', 'keeper'), now: NOW })).toEqual({ error: 'successor', state: 'obsolete' });
      expect(sqlite.query("SELECT status, revision FROM spores WHERE id = 'source'").get()).toEqual({ status: 'active', revision: 0 });
      expect(sqlite.query("SELECT id FROM resolution_events WHERE id <> 'e4'").all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('answers a replayed event id as a duplicate without moving the revision again', async () => {
    const { db, sqlite } = seeded();
    try {
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re', 'keeper'), now: NOW })).toBe(true);
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re', 'keeper'), now: NOW + 1, expect: { status: 'superseded' } })).toBe('duplicate');
      expect(sqlite.query("SELECT status, revision FROM spores WHERE id = 'source'").get()).toEqual({ status: 'superseded', revision: 1 });
      expect(sqlite.query('SELECT COUNT(*) AS n FROM resolution_events').get()).toEqual({ n: 1 });
    } finally { sqlite.close(); }
  });

  it('keeps every source and writes no wisdom when any write of a consolidation fails midway', async () => {
    const { db, sqlite } = seeded();
    try {
      const sources = [{ id: 'source', revision: 0 }, { id: 'keeper', revision: 0 }];
      await expect(consolidateSpores(db, SCOPE, { wisdom: spore('wisdom'), sources, event: { agentId: 'no-such-agent', reason: null, sessionId: null, author: null, createdAt: NOW }, now: NOW })).rejects.toThrow();
      expect(sqlite.query("SELECT status, revision FROM spores WHERE id IN ('source', 'keeper') ORDER BY id").all()).toEqual([{ status: 'active', revision: 0 }, { status: 'active', revision: 0 }]);
      expect(sqlite.query("SELECT id FROM spores WHERE id = 'wisdom'").all()).toEqual([]);
      expect(sqlite.query('SELECT id FROM resolution_events').all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('names the first source a consolidation cannot take, in the order the caller listed them', async () => {
    const { db, sqlite } = seeded();
    try {
      await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('gone', null, 'keeper'), action: 'obsolete' }, now: NOW });
      const outcome = await consolidateSpores(db, SCOPE, { wisdom: spore('w'), sources: [{ id: 'source', revision: 0 }, { id: 'keeper', revision: 0 }, { id: 'ghost' }],
        event: { agentId: AGENT, reason: null, sessionId: null, author: null, createdAt: NOW }, now: NOW });
      expect(outcome).toEqual({ wisdom: null, consolidated: 0, stale: { id: 'keeper', status: 'obsolete', revision: 1, expected: 0 } });
      const absent = await consolidateSpores(db, SCOPE, { wisdom: spore('w2'), sources: [{ id: 'ghost' }, { id: 'source' }], event: { agentId: AGENT, reason: null, sessionId: null, author: null, createdAt: NOW }, now: NOW });
      expect(absent.stale).toEqual({ id: 'ghost', status: null, revision: null, expected: null });
    } finally { sqlite.close(); }
  });

  it('lets an import name a successor that is absent or already retired, because a vault chain arrives out of order', async () => {
    const { db, sqlite } = seeded();
    try {
      sqlite.query("UPDATE spores SET status = 'superseded' WHERE id = 'keeper'").run();
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: { ...event('i1', 'ghost'), channel: 'import' }, now: NOW })).toBe(true);
      sqlite.query("UPDATE spores SET status = 'active' WHERE id = 'source'").run();
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: { ...event('i2', 'keeper'), channel: 'import' }, now: NOW })).toBe(true);
      expect(sqlite.query('SELECT new_spore_id FROM resolution_events ORDER BY id').all()).toEqual([{ new_spore_id: 'ghost' }, { new_spore_id: 'keeper' }]);
    } finally { sqlite.close(); }
  });

  it('treats another writer\'s successor as absent for a grant, and moves nothing', async () => {
    const { db, sqlite } = seeded();
    try {
      sqlite.query("UPDATE spores SET author = 'grant-b' WHERE id = 'source'").run();
      sqlite.query("UPDATE spores SET author = 'grant-a' WHERE id = 'keeper'").run();
      expect(await resolveSpore(db, SCOPE, { status: 'superseded', event: event('g1', 'keeper'), now: NOW, authority: { kind: 'grant', grantId: 'grant-b' } })).toEqual({ error: 'successor', state: 'missing' });
      expect(sqlite.query("SELECT status FROM spores WHERE id = 'source'").get()).toEqual({ status: 'active' });
      expect((sqlite.query('SELECT COUNT(*) c FROM resolution_events').get() as { c: number }).c).toBe(0);
    } finally { sqlite.close(); }
  });

  it('hides a source another writer holds from a grant, as absent rather than as a stale revision', async () => {
    const { db, sqlite } = seeded();
    try {
      sqlite.query("UPDATE spores SET author = 'grant-a' WHERE id = 'source'").run();
      expect(await resolveSpore(db, SCOPE, { status: 'obsolete', event: { ...event('g', null, 'source'), action: 'obsolete' }, now: NOW, authority: { kind: 'grant', grantId: 'grant-b' } })).toBe(false);
      expect((await consolidateSpores(db, SCOPE, { wisdom: spore('w'), sources: [{ id: 'source', revision: 0 }], event: { agentId: AGENT, reason: null, sessionId: null, author: null, createdAt: NOW }, now: NOW, authority: { kind: 'grant', grantId: 'grant-b' } })).stale)
        .toEqual({ id: 'source', status: null, revision: null, expected: 0 });
    } finally { sqlite.close(); }
  });

  it('moves every source in one write, each with its own event, under one successor', async () => {
    const { db, sqlite } = seeded();
    try {
      const merged = await consolidateSpores(db, SCOPE, { wisdom: spore('w'), sources: [{ id: 'source', revision: 0 }, { id: 'keeper' }], event: { agentId: AGENT, reason: 'merged', sessionId: null, author: 'mem_1', createdAt: NOW }, now: NOW + 5 });
      expect(merged.consolidated).toBe(2);
      expect(sqlite.query("SELECT status, revision, updated_at FROM spores WHERE id = 'source'").get()).toEqual({ status: 'consolidated', revision: 1, updated_at: NOW + 5 });
      expect(sqlite.query("SELECT spore_id, action, new_spore_id, author FROM resolution_events ORDER BY spore_id").all()).toEqual([
        { spore_id: 'keeper', action: 'consolidate', new_spore_id: 'w', author: 'mem_1' },
        { spore_id: 'source', action: 'consolidate', new_spore_id: 'w', author: 'mem_1' },
      ]);
    } finally { sqlite.close(); }
  });

  it('browses lineage from canonical edges once built, and from the events while they are still building', async () => {
    const { db, sqlite } = seeded();
    try {
      sqlite.query("UPDATE projection_catchup SET done = 0 WHERE projection = 'spore_resolution_edges'").run();
      await resolveSpore(db, SCOPE, { status: 'superseded', event: event('re1', 'keeper'), now: NOW });
      sqlite.query('DELETE FROM spore_resolution_edges').run();
      expect(await listSupersedingSporeIds(db, SCOPE, 'source')).toEqual(['keeper']);
      expect(await listSupersededSporeIds(db, SCOPE, 'keeper')).toEqual(['source']);

      expect(await catchUpPhaseDone(db)).toBe(1);
      expect(sqlite.query('SELECT source_id, target_id, action FROM spore_resolution_edges').all()).toEqual([{ source_id: 'source', target_id: 'keeper', action: 'supersede' }]);
      expect(await listSupersedingSporeIds(db, SCOPE, 'source')).toEqual(['keeper']);
      expect(await listSupersededSporeIds(db, SCOPE, 'keeper')).toEqual(['source']);
    } finally { sqlite.close(); }
  });

  it('holds one edge for a repeated source and successor, and moves it to the newest event', async () => {
    const { db, sqlite } = seeded();
    try {
      for (const [id, at] of [['a', NOW + 1], ['b', NOW + 5], ['c', NOW + 3]] as const) {
        sqlite.query("INSERT INTO resolution_events (project_id, id, agent_id, spore_id, action, new_spore_id, created_at) VALUES (?, ?, ?, 'source', 'supersede', 'keeper', ?)").run(SCOPE.projectId, id, AGENT, at);
      }
      expect(sqlite.query('SELECT last_event_id, last_event_at FROM spore_resolution_edges').all()).toEqual([{ last_event_id: 'b', last_event_at: NOW + 5 }]);
    } finally { sqlite.close(); }
  });
});

describe('a consolidation, executed', () => {
  it('stores the wisdom spore with its agent line and files the events with their provenance', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('a'));
    await insertSpore(db, SCOPE, spore('b'));

    const { wisdom, consolidated } = await consolidateSpores(db, SCOPE, { wisdom: spore('w', { observationType: 'wisdom', content: 'the merged note', agentLine: 'selector drops the tail → keep the record equal to the render', author: 'mem_1', provenance: { kind: 'pr', ref: 'goondocks/myco#1150' } }), sources: [{ id: 'a' }, { id: 'b' }], event: { agentId: AGENT, reason: 'one note covers both', sessionId: null, author: 'mem_1', provenance: { kind: 'pr', ref: 'goondocks/myco#1150' }, createdAt: NOW + 1 }, now: NOW + 1 });

    expect(consolidated).toBe(2);
    expect(wisdom).toMatchObject({ id: 'w', agentLine: 'selector drops the tail → keep the record equal to the render', author: 'mem_1', provenanceKind: 'pr', provenanceRef: 'goondocks/myco#1150' });

    const events = sqlite.query(`SELECT spore_id, action, new_spore_id, author, provenance_kind, provenance_ref FROM resolution_events ORDER BY spore_id`).all();
    expect(events).toEqual([
      { spore_id: 'a', action: 'consolidate', new_spore_id: 'w', author: 'mem_1', provenance_kind: 'pr', provenance_ref: 'goondocks/myco#1150' },
      { spore_id: 'b', action: 'consolidate', new_spore_id: 'w', author: 'mem_1', provenance_kind: 'pr', provenance_ref: 'goondocks/myco#1150' },
    ]);
  });

  it('leaves the agent line null where no run has derived one', async () => {
    const { db } = store();
    const row = await insertSpore(db, SCOPE, spore('a'));
    expect(row?.agentLine).toBeNull();
  });
});
