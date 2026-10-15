import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { LEGACY_HISTORY_SQL, LEGACY_SPORES_SQL, LEGACY_LINEAGE_SQL } from '@myco-server-worker/read/legacy-history.js';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH, LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';
import { memberPost, noOutboundFetch, sqliteEnv, uuid } from './helpers/fixtures.js';
import { jsonBody } from '../helpers/json-body.js';

describe('source-specific legacy history confirmation', () => {
  it('requires exact source, Project, machine, channel and import producer, including archived Projects', async () => {
    const fixture = sqliteEnv();
    try {
      const token = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.32', fetchImpl: noOutboundFetch });
      const post = (body: unknown, path = LEGACY_HISTORY_PATH, extra = {}) => server.handleRequest(memberPost(token.token, body, path, extra), fixture.serverEnv);
      const eventId = uuid(81);
      const event = (id: string, kind: string, payload: unknown) => post({ eventId: id, sessionId: 'source-session', kind, createdAt: 1000, channel: 'import', producer: { adapter: LEGACY_IMPORT_ADAPTER, version: '1' }, payload }, '/events');
      expect((await jsonBody<Record<string, unknown>>(await event(uuid(80), 'session.start', { agent: 'claude-code', startedAt: 1000 }))).persisted).toBe(true);
      expect((await jsonBody<Record<string, unknown>>(await event(eventId, 'session.end', { endedAt: 1000 }))).persisted).toBe(true);
      const probe = async (groups = [[eventId]], extra = {}) => jsonBody<Record<string, unknown>>(await post({ eventGroups: groups }, LEGACY_HISTORY_PATH, extra));
      expect(await probe()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] });
      expect(await probe([[uuid(82)]])).toEqual({ persisted: true, confirmed: false });
      expect(await probe([[eventId], [uuid(82)]])).toEqual({ persisted: true, confirmed: false });
      expect((await jsonBody<Record<string, unknown>>(await event(uuid(83), 'session.end', { title: 'Retained title' }))).persisted).toBe(true);
      expect(await probe([[uuid(83)]])).toEqual({ persisted: true, confirmed: false });
      fixture.sqlite.run("UPDATE events SET channel = 'cli' WHERE event_id = ?", [uuid(80)]);
      expect(await probe([[uuid(83)]])).toEqual({ persisted: true, confirmed: true, eventIds: [uuid(83)] });
      fixture.sqlite.run("UPDATE events SET channel = 'import' WHERE event_id = ?", [uuid(80)]);
      expect(await probe([[uuid(80)]])).toEqual({ persisted: true, confirmed: false });
      for (const [table, column, value] of [['events', 'channel', 'cli'], ['events', 'producer_adapter', 'claude-code'], ['sessions', 'machine_id', 'machine_2']] as const) {
        const original = fixture.sqlite.query(`SELECT ${column} AS value FROM ${table} WHERE project_id = 'proj_1'`).get() as { value: string };
        fixture.sqlite.run(`UPDATE ${table} SET ${column} = ? WHERE project_id = 'proj_1'`, [value]);
        expect(await probe()).toEqual({ persisted: true, confirmed: false });
        fixture.sqlite.run(`UPDATE ${table} SET ${column} = ? WHERE project_id = 'proj_1'`, [original.value]);
      }
      expect(await probe([[eventId]], { 'x-myco-project': 'proj_2' })).toEqual({ persisted: true, confirmed: false });
      fixture.sqlite.run("UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'");
      expect(await probe()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] });
      const plan = fixture.sqlite.query(`EXPLAIN QUERY PLAN ${LEGACY_HISTORY_SQL}`).all('proj_1', JSON.stringify([eventId]), LEGACY_IMPORT_ADAPTER, 'machine_1') as { detail: string }[];
      expect(plan.map(row => row.detail).join('\n')).toContain('SEARCH e USING INDEX sqlite_autoindex_events_1 (project_id=? AND event_id=?)');
      expect(plan.map(row => row.detail).join('\n')).toContain('SEARCH f USING INDEX sqlite_autoindex_events_1');
      expect(plan.map(row => row.detail).join('\n')).toMatch(/SEARCH s (?:EXISTS )?USING INDEX sqlite_autoindex_sessions_1 \(project_id=\? AND session_id=\?\)/);
      expect((await probe(Array.from({ length: LEGACY_HISTORY_MAX_EVENTS + 1 }, () => [eventId]))).confirmed).toBeUndefined();
      expect((await jsonBody<Record<string, unknown>>(await post({ eventGroups: [] }))).persisted).toBe(false);
      expect((await jsonBody<Record<string, unknown>>(await post({ eventGroups: [['invalid']] }))).persisted).toBe(false);
      fixture.sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_1'");
      const projects = fixture.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all();
      expect((await probe([[eventId]], { 'x-myco-project': 'proj_unknown' })).confirmed).not.toBe(true);
      expect(fixture.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all()).toEqual(projects);
      fixture.sqlite.run('PRAGMA foreign_keys = OFF');
      fixture.sqlite.run("DELETE FROM projects WHERE project_id = 'proj_1'");
      expect((await probe()).confirmed).not.toBe(true);
      expect(fixture.sqlite.query("SELECT project_id FROM projects WHERE project_id = 'proj_1'").get()).toBeNull();
    } finally { fixture.sqlite.close(); }
  });
});


it('requires every spore and lineage ID with Project, member and available machine attribution', async () => {
  const fixture = sqliteEnv();
  try {
    const token = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.32', fetchImpl: noOutboundFetch });
    const post = async (path: string, body: unknown, headers = {}) => jsonBody<Record<string, unknown>>(await server.handleRequest(memberPost(token.token, body, path, headers), fixture.serverEnv));
    expect((await post('/spores/save', { channel: 'import', id: 'source-spore', agentId: 'user', observationType: 'gotcha', content: 'Retained fact' })).persisted).toBe(true);
    expect((await post('/spores/resolve', { channel: 'import', eventId: 'source-lineage', sporeId: 'source-spore', agentId: 'user', action: 'obsolete', status: 'obsolete' })).persisted).toBe(true);
    const probe = (extra = {}) => post(LEGACY_HISTORY_PATH, { eventGroups: [], sporeIds: ['source-spore'], lineageIds: ['source-lineage'], ...extra });
    expect(await probe()).toEqual({ persisted: true, confirmed: true, eventIds: [], sporeIds: ['source-spore'], lineageIds: ['source-lineage'] });
    expect((await probe({ sporeIds: ['source-spore', 'missing'] })).confirmed).toBe(false);
    expect((await probe({ lineageIds: ['missing'] })).confirmed).toBe(false);
    for (const table of ['spores', 'resolution_events']) {
      fixture.sqlite.run(`UPDATE ${table} SET author = 'another-member' WHERE project_id = 'proj_1'`);
      expect((await probe()).confirmed).toBe(false);
      fixture.sqlite.run(`UPDATE ${table} SET author = 'mem_machine_1' WHERE project_id = 'proj_1'`);
    }
    await post('/events', { eventId: uuid(95), sessionId: 'linked', kind: 'session.start', createdAt: Date.now(), channel: 'import', producer: { adapter: LEGACY_IMPORT_ADAPTER, version: '1' }, payload: { agent: 'claude-code', startedAt: Date.now() } });
    for (const table of ['spores', 'resolution_events']) {
      fixture.sqlite.run(`UPDATE ${table} SET session_id = 'linked' WHERE project_id = 'proj_1'`);
      expect((await probe()).confirmed).toBe(true);
      fixture.sqlite.run("UPDATE sessions SET machine_id = 'other' WHERE session_id = 'linked'");
      expect((await probe()).confirmed).toBe(false);
      fixture.sqlite.run("UPDATE sessions SET machine_id = 'machine_1' WHERE session_id = 'linked'");
      fixture.sqlite.run(`UPDATE ${table} SET session_id = NULL WHERE project_id = 'proj_1'`);
    }
    fixture.sqlite.run("UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'");
    expect((await probe()).confirmed).toBe(true);
    for (const [sql, table] of [[LEGACY_SPORES_SQL, 'spores'], [LEGACY_LINEAGE_SQL, 'resolution_events']] as const) {
      const plan = fixture.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all('proj_1', '["source-spore"]', 'mem_machine_1', 'machine_1') as { detail: string }[];
      expect(plan.map(row => row.detail).join('\n')).toContain(`SEARCH r USING INDEX sqlite_autoindex_${table}_1 (project_id=? AND id=?)`);
      expect(plan.map(row => row.detail).join('\n')).toMatch(/SEARCH s (?:EXISTS )?USING INDEX sqlite_autoindex_sessions_1/);
    }
    expect((await probe({ sporeIds: Array.from({ length: LEGACY_HISTORY_MAX_EVENTS }, () => 'source-spore') })).persisted).toBe(false);
  } finally { fixture.sqlite.close(); }
});
