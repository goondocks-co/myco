import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { LEGACY_HISTORY_SQL } from '@myco-server-worker/read/legacy-history.js';
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
