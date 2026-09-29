import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';
import { LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';

/**
 * A Myco 1.4 vault import, identical on both front doors (#1161): what the
 * import plan says of a session whose prompts the vault supplied, what the
 * session probe answers, a title-only import end that leaves the session's
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
    const transcriptId = `tx_${'e'.repeat(32)}`;
    const plan = await (await post('/import/plan', {
      windowDays: 3650,
      sessions: [vaultSession],
      candidates: [{ sessionId: vaultSession, transcriptId, agent: 'claude-code', sizeBytes: 10, modifiedAt: stamp, headHash: null }],
    })).json() as { candidates: Array<Record<string, unknown>>; sessions: { held: string[]; vaultSourced: string[]; withTranscript: string[]; tombstoned: string[] } };
    expect(plan.candidates).toEqual([{ transcriptId, take: 'none', reason: 'vault_sourced' }]);
    expect(plan.sessions).toEqual({ held: [vaultSession], withTranscript: [], tombstoned: [], vaultSourced: [vaultSession] });

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
  },
};
