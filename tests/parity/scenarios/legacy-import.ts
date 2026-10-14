import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';
import { LEGACY_HISTORY_PATH, LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';
import { LEGACY_HISTORY_SQL, LEGACY_RECORDS_SQL, LEGACY_SPORES_SQL, LEGACY_LINEAGE_SQL } from '@myco-server-worker/read/legacy-history.js';

/**
 * A Myco 1.4 vault import, identical on both front doors (#1161): what the
 * import plan says of a session whose prompts the vault supplied and of three
 * that only look like one, what the session probe answers, a title-only import end that leaves the session's
 * end alone, and a spore resolution replayed with its own time.
 */
export const legacyImportParity: ParityScenario = {
  name: '1.4 vault import: a vault-sourced session takes no transcript, the probe, a title-only end, a replayed resolution',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const post = (path: string, body: unknown) => fetch(`${target.url}${path}`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const event = (sessionId: string, kind: string, channel: 'cli' | 'import', payload: Record<string, unknown>, createdAt: number, adapter = LEGACY_IMPORT_ADAPTER) =>
      post('/events', { eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel, producer: { adapter, version: '1' }, payload });

    // A session whose prompts the vault supplied: the plan admits no transcript for it, and the probe says so.
    const vaultSession = `parity-legacy-vault-${stamp}`;
    await expectPersisted(await event(vaultSession, 'session.start', 'import', { agent: 'claude-code', startedAt: stamp - 60_000 }, stamp - 60_000), 'vault start');
    await expectPersisted(await event(vaultSession, 'prompt', 'import', { promptId: crypto.randomUUID(), text: 'from the vault', origin: 'user' }, stamp - 59_000), 'vault prompt');
    // Three sessions that only look like it: an import-channel prompt another producer sent, the
    // import producer's prompt on another channel, and the import producer's start with no prompt.
    const otherProducer = `parity-legacy-other-producer-${stamp}`;
    await expectPersisted(await event(otherProducer, 'session.start', 'import', { agent: 'claude-code', startedAt: stamp - 60_000 }, stamp - 60_000, 'parity'), 'other producer start');
    await expectPersisted(await event(otherProducer, 'prompt', 'import', { promptId: crypto.randomUUID(), text: 'imported by another producer', origin: 'user' }, stamp - 59_000, 'parity'), 'other producer prompt');
    const otherChannel = `parity-legacy-other-channel-${stamp}`;
    await expectPersisted(await event(otherChannel, 'session.start', 'cli', { agent: 'claude-code', startedAt: stamp - 60_000 }, stamp - 60_000), 'other channel start');
    await expectPersisted(await event(otherChannel, 'prompt', 'cli', { promptId: crypto.randomUUID(), text: 'captured live', origin: 'user' }, stamp - 59_000), 'other channel prompt');
    const startOnly = `parity-legacy-start-only-${stamp}`;
    await expectPersisted(await event(startOnly, 'session.start', 'import', { agent: 'claude-code', startedAt: stamp - 60_000 }, stamp - 60_000), 'start-only start');

    const lookalikes = [otherProducer, otherChannel, startOnly];
    const txOf = (n: number) => `tx_${String(n).repeat(32)}`;
    const transcriptId = `tx_${'e'.repeat(32)}`;
    const plan = await (await post('/import/plan', {
      windowDays: 3650,
      sessions: [vaultSession, ...lookalikes],
      candidates: [
        { sessionId: vaultSession, transcriptId, agent: 'claude-code', sizeBytes: 10, modifiedAt: stamp, headHash: null },
        ...lookalikes.map((sessionId, i) => ({ sessionId, transcriptId: txOf(i + 1), agent: 'claude-code', sizeBytes: 10, modifiedAt: stamp, headHash: null })),
      ],
    })).json() as { candidates: Array<Record<string, unknown>>; sessions: { held: string[]; vaultSourced: string[]; withTranscript: string[]; tombstoned: string[] } };
    expect(plan.candidates).toEqual([
      { transcriptId, take: 'none', reason: 'vault_sourced' },
      ...lookalikes.map((_, i) => ({ transcriptId: txOf(i + 1), take: 'from', fromOffset: 0 })),
    ]);
    expect({ ...plan.sessions, held: [...plan.sessions.held].sort() }).toEqual({ held: [vaultSession, ...lookalikes].sort(), withTranscript: [], tombstoned: [], vaultSourced: [vaultSession] });

    // A title-only import end: the title lands, the session's end stays live capture's.
    const liveSession = `parity-legacy-live-${stamp}`;
    const endedAt = stamp - 30_000;
    await expectPersisted(await event(liveSession, 'session.start', 'cli', { agent: 'claude-code', startedAt: stamp - 40_000 }, stamp - 40_000, 'parity'), 'live start');
    await expectPersisted(await event(liveSession, 'session.end', 'cli', { endedAt }, endedAt, 'parity'), 'live end');
    await expectPersisted(await event(liveSession, 'session.end', 'import', { title: 'A 1.4 title' }, stamp - 20_000), 'title-only end');
    const [row] = await target.sql(`SELECT title, ended_at, titled_at IS NOT NULL AS titled FROM sessions WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(liveSession)}`);
    expect({ title: row.title, endedAt: Number(row.ended_at), titled: Number(row.titled) }).toEqual({ title: 'A 1.4 title', endedAt, titled: 1 });

    // A resolution on the import channel keeps its time; replayed, it moves nothing a later change set.
    const spore = `parity-legacy-spore-${stamp}`;
    await expectPersisted(await post('/spores/save', { id: spore, agentId: 'user', observationType: 'gotcha', content: 'kept' }), 'spore');
    const source = { channel: 'import', id: spore, agentId: 'user', observationType: 'gotcha', content: 'kept', sessionId: startOnly };
    await expectPersisted(await post('/spores/save', source), 'session-only source repair');
    const sourceLinks = () => target.sql(`SELECT session_id, prompt_id FROM spores WHERE project_id = ${lit(target.projectId)} AND id = ${lit(spore)}`);
    expect(await sourceLinks()).toEqual([{ session_id: startOnly, prompt_id: null }]);
    const kept = await (await post('/spores/save', { ...source, sessionId: liveSession })).json() as Record<string, unknown>;
    expect(kept.persisted).toBe(true);
    expect(kept.sourceKept).toBe(true);
    expect(await sourceLinks()).toEqual([{ session_id: startOnly, prompt_id: null }]);
    const resolve = async (eventId: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> =>
      await (await post('/spores/resolve', { eventId, agentId: 'user', sporeId: spore, action: 'obsolete', status: 'obsolete', createdAt: 1_000, ...extra })).json() as Record<string, unknown>;
    const imported = `parity-legacy-res-${stamp}`;
    expect(await resolve(imported, { channel: 'import' })).toEqual({ persisted: true, resolved: true });
    await target.sql(`UPDATE spores SET status = 'active' WHERE project_id = ${lit(target.projectId)} AND id = ${lit(spore)}`);
    expect(await resolve(imported, { channel: 'import' })).toEqual({ persisted: true, resolved: true, duplicate: true });
    const plain = `parity-legacy-res-plain-${stamp}`;
    expect(await resolve(plain, {})).toEqual({ persisted: true, resolved: true });
    const history = await target.sql(`SELECT id, created_at FROM resolution_events WHERE project_id = ${lit(target.projectId)} AND spore_id = ${lit(spore)} ORDER BY id`);
    const at = new Map(history.map((h) => [String(h.id), Number(h.created_at)]));
    expect(at.get(imported)).toBe(1_000);
    expect(at.get(plain)).toBeGreaterThan(1_000);

    await expectPersisted(await event(vaultSession, 'session.end', 'import', { title: 'Retained legacy session' }, stamp), 'legacy completion');
    const [titleEvent] = await target.sql(`SELECT event_id FROM events WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(vaultSession)} AND kind = 'session.end'`);
    expect((await (await post(LEGACY_HISTORY_PATH, { eventGroups: [[String(titleEvent.event_id)]] })).json() as { confirmed: boolean }).confirmed).toBe(false);
    await expectPersisted(await event(vaultSession, 'session.end', 'import', { endedAt: stamp }, stamp + 1), 'legacy lifecycle completion');
    const [sourceEvent] = await target.sql(`SELECT event_id FROM events WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(vaultSession)} AND kind = 'session.end' AND json_type(payload, '$.endedAt') IS NOT NULL`);
    const eventId = String(sourceEvent.event_id);
    const confirmation = async (eventGroups = [[eventId]]) => (await post(LEGACY_HISTORY_PATH, { eventGroups })).json();
    expect(await confirmation()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] });
    expect(await confirmation([[eventId], [crypto.randomUUID()]])).toEqual({ persisted: true, confirmed: false });
    const [owner] = await target.sql(`SELECT machine_id FROM sessions WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(vaultSession)}`);
    await target.sql(`UPDATE sessions SET machine_id = 'machine_2' WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(vaultSession)}`);
    expect(await confirmation()).toEqual({ persisted: true, confirmed: false });
    await target.sql(`UPDATE sessions SET machine_id = ${lit(String(owner.machine_id))} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(vaultSession)}`);
    await target.sql(`UPDATE projects SET archived_at = 1 WHERE project_id = ${lit(target.projectId)}`);
    try { expect(await confirmation()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] }); }
    finally { await target.sql(`UPDATE projects SET archived_at = NULL WHERE project_id = ${lit(target.projectId)}`); }
    const binds = [target.projectId, JSON.stringify([eventId]), LEGACY_IMPORT_ADAPTER, String(owner.machine_id)];
    let bind = 0;
    const proof = LEGACY_HISTORY_SQL.replace(/\?/g, () => lit(binds[bind++]!));
    const queryPlan = (await target.sql(`EXPLAIN QUERY PLAN ${proof}`)).map(row => row.detail).join('\n');
    expect(queryPlan).toContain('SEARCH e USING INDEX sqlite_autoindex_events_1 (project_id=? AND event_id=?)');
    expect(queryPlan).toContain('SEARCH f USING INDEX sqlite_autoindex_events_1');
    expect(queryPlan).toMatch(/SEARCH s (?:EXISTS )?USING INDEX sqlite_autoindex_sessions_1 \(project_id=\? AND session_id=\?\)/);
    const sourceIds = { eventGroups: [[eventId]], recordIds: [String(titleEvent.event_id)], sporeIds: [spore], lineageIds: [imported] };
    const fullProof = async (extra = {}) => (await post(LEGACY_HISTORY_PATH, { ...sourceIds, ...extra })).json() as Promise<{ confirmed: boolean }>;
    expect((await fullProof()).confirmed).toBe(true);
    expect((await fullProof({ sporeIds: [spore, 'absent-spore'] })).confirmed).toBe(false);
    expect((await fullProof({ lineageIds: ['absent-lineage'] })).confirmed).toBe(false);
    const [author] = await target.sql(`SELECT author FROM spores WHERE project_id = ${lit(target.projectId)} AND id = ${lit(spore)}`);
    for (const table of ['spores', 'resolution_events']) {
      await target.sql(`UPDATE ${table} SET author = 'other-member' WHERE project_id = ${lit(target.projectId)}`);
      expect((await fullProof()).confirmed).toBe(false);
      await target.sql(`UPDATE ${table} SET author = ${lit(String(author.author))} WHERE project_id = ${lit(target.projectId)}`);
    }
    for (const [sql, table] of [[LEGACY_SPORES_SQL, 'spores'], [LEGACY_LINEAGE_SQL, 'resolution_events']] as const) {
      const values = [target.projectId, JSON.stringify([spore]), String(author.author), String(owner.machine_id)];
      let index = 0;
      const plan = (await target.sql(`EXPLAIN QUERY PLAN ${sql.replace(/\?/g, () => lit(values[index++]!))}`)).map(row => row.detail).join('\n');
      expect(plan).toContain(`SEARCH r USING INDEX sqlite_autoindex_${table}_1 (project_id=? AND id=?)`);
      expect(plan).toMatch(/SEARCH s (?:EXISTS )?USING INDEX sqlite_autoindex_sessions_1/);
    }
    let recordBind = 0;
    const recordPlan = (await target.sql(`EXPLAIN QUERY PLAN ${LEGACY_RECORDS_SQL.replace(/\?/g, () => lit(binds[recordBind++]!))}`)).map(row => row.detail).join('\n');
    expect(recordPlan).toContain('SEARCH e USING INDEX sqlite_autoindex_events_1 (project_id=? AND event_id=?)');
    const projectsBefore = await target.sql('SELECT project_id FROM projects ORDER BY project_id');
    const missing = await fetch(`${target.url}${LEGACY_HISTORY_PATH}`, { method: 'POST', headers: { ...target.memberHeaders(), 'x-myco-project': `proj_missing_${stamp}`, 'content-type': 'application/json' }, body: JSON.stringify({ eventGroups: [[eventId]] }) });
    expect((await missing.json() as { confirmed?: boolean }).confirmed).not.toBe(true);
    expect(await target.sql('SELECT project_id FROM projects ORDER BY project_id')).toEqual(projectsBefore);
  },
};
