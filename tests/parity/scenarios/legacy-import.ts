import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';
import { owner, mcp, sessionDetail } from '../clients/requests.ts';
import { archived } from '../clients/requests.ts';
import { joinMember, stopMember } from '../clients/identity.ts';
import { withSettings } from '../clients/settings.ts';
import { memberHeadersFor } from '../harness.ts';
import { transcript } from '../clients/capture.ts';
import { LEGACY_HISTORY_PATH, LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';

/**
 * A Myco 1.4 vault import, identical on both front doors (#1161): what the
 * import plan says of a session whose prompts the vault supplied and of three
 * that only look like one, what the session probe answers, a title-only import end that leaves the session's
 * end alone, and a spore resolution replayed with its own time.
 */
export const legacyImportParity: ParityScenario = {
  name: '1.4 vault import: a vault-sourced session takes no transcript, the probe, a title-only end, a replayed resolution',
  async run(target: ParityTarget) {
    await withSettings(target, { 'import.enabled': true }, async () => {
      const stamp = Date.now();
      const post = (path: string, body: unknown) => fetch(`${target.url}${path}`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const eventIds = new Map<string, string>();
      const event = (sessionId: string, kind: string, channel: 'cli' | 'import', payload: Record<string, unknown>, createdAt: number, adapter = LEGACY_IMPORT_ADAPTER) =>
        { const eventId = crypto.randomUUID(); eventIds.set(`${sessionId}:${kind}`, eventId); return post('/events', { eventId, sessionId, kind, createdAt, channel, producer: { adapter, version: '1' }, payload }); };

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
      expect((await sessionDetail(target, liveSession)).body.session).toMatchObject({ title: 'A 1.4 title', endedAt, titledAt: expect.any(Number) });

      // An imported resolution keeps its source time and replays without another revision.
      const spore = `parity-legacy-spore-${stamp}`;
      await expectPersisted(await post('/spores/save', { id: spore, agentId: 'user', observationType: 'gotcha', content: 'kept', agentLine: 'When importing this history, retain its source.' }), 'spore');
      const source = { channel: 'import', id: spore, agentId: 'user', observationType: 'gotcha', content: 'kept', sessionId: startOnly };
      await expectPersisted(await post('/spores/save', source), 'session-only source repair');
      const sourceLinks = () => mcp(target, 'myco_spores', { op: 'get', id: spore });
      expect(await sourceLinks()).toMatchObject({ session_id: startOnly });
      const kept = await (await post('/spores/save', { ...source, sessionId: liveSession })).json() as Record<string, unknown>;
      expect(kept.persisted).toBe(true);
      expect(kept.sourceKept).toBe(true);
      expect(await sourceLinks()).toMatchObject({ session_id: startOnly });
      const resolve = async (eventId: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> =>
        await (await post('/spores/resolve', { eventId, agentId: 'user', sporeId: spore, action: 'obsolete', status: 'obsolete', reason: 'Retired in this fixture.', createdAt: 1_000, ...extra })).json() as Record<string, unknown>;
      const imported = `parity-legacy-res-${stamp}`;
      expect(await resolve(imported, { channel: 'import' })).toEqual({ persisted: true, resolved: true });
      expect(await sourceLinks()).toMatchObject({ status: 'obsolete', revision: 1, updated_at: 1000 });
      expect(await resolve(imported, { channel: 'import' })).toEqual({ persisted: true, resolved: true, duplicate: true });
      expect(await sourceLinks()).toMatchObject({ status: 'obsolete', revision: 1, updated_at: 1000 });
      const ordinarySpore = `${spore}-ordinary`;
      await expectPersisted(await post('/spores/save', { id: ordinarySpore, agentId: 'user', observationType: 'gotcha', content: 'ordinary lifecycle', agentLine: 'Use the live edit time.' }), 'ordinary spore');
      expect(await (await post('/spores/resolve', { eventId: `${imported}-ordinary`, sporeId: ordinarySpore, agentId: 'user', action: 'obsolete', status: 'obsolete', reason: 'Retired live.', createdAt: 1000 })).json()).toEqual({ persisted: true, resolved: true });
      expect((await mcp(target, 'myco_spores', { op: 'get', id: ordinarySpore })).updated_at).toBeGreaterThan(1000);

      await expectPersisted(await event(vaultSession, 'session.end', 'import', { title: 'Retained legacy session' }, stamp), 'legacy completion');
      const titleEvent = eventIds.get(`${vaultSession}:session.end`)!;
      expect((await (await post(LEGACY_HISTORY_PATH, { eventGroups: [[titleEvent]] })).json() as { confirmed: boolean }).confirmed).toBe(false);
      await expectPersisted(await event(vaultSession, 'session.end', 'import', { endedAt: stamp }, stamp + 1), 'legacy lifecycle completion');
      const eventId = eventIds.get(`${vaultSession}:session.end`)!;
      const confirmation = async (eventGroups = [[eventId]]) => (await post(LEGACY_HISTORY_PATH, { eventGroups })).json();
      expect(await confirmation()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] });
      expect(await confirmation([[eventId], [crypto.randomUUID()]])).toEqual({ persisted: true, confirmed: false });
      const otherMachine = await joinMember(target);
      try {
        const otherPost = (body: unknown) => fetch(`${target.url}${LEGACY_HISTORY_PATH}`, { method: 'POST', headers: memberHeadersFor(otherMachine.token, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
        expect(await (await otherPost({ eventGroups: [[eventId]] })).json()).toEqual({ persisted: true, confirmed: false });
        await archived(target, target.projectId, async () => { expect(await confirmation()).toEqual({ persisted: true, confirmed: true, eventIds: [eventId] }); });
        const sourceIds = { eventGroups: [[eventId]], recordIds: [titleEvent], sporeIds: [spore], lineageIds: [imported] };
        const fullProof = async (extra = {}) => (await post(LEGACY_HISTORY_PATH, { ...sourceIds, ...extra })).json() as Promise<{ confirmed: boolean }>;
        expect((await fullProof()).confirmed).toBe(true);
        expect((await fullProof({ sporeIds: [spore, 'absent-spore'] })).confirmed).toBe(false);
        expect((await fullProof({ lineageIds: ['absent-lineage'] })).confirmed).toBe(false);
        expect((await (await otherPost(sourceIds)).json() as { confirmed: boolean }).confirmed).toBe(false);
        const contentProbe = async (sessions = [vaultSession, startOnly]) => (await post(LEGACY_HISTORY_PATH, { eventGroups: [], sessions, projectState: true })).json();
        await transcript(target, startOnly, `${JSON.stringify({ type: 'user', message: { content: 'legacy transcript' } })}\n`);
        expect(await contentProbe()).toEqual({ persisted: true, confirmed: true, eventIds: [], projectState: 'active', sources: { withTranscript: [startOnly], vaultSourced: [vaultSession] } });
        expect(await (await otherPost({ eventGroups: [], sessions: [vaultSession, startOnly], projectState: true })).json()).toMatchObject({ sources: { withTranscript: [], vaultSourced: [vaultSession] } });
        await archived(target, target.projectId, async () => { expect(await contentProbe()).toMatchObject({ projectState: 'archived' }); });
        const missingState = await fetch(`${target.url}${LEGACY_HISTORY_PATH}`, { method: 'POST', headers: { ...target.memberHeaders(), 'x-myco-project': `proj_missing_${stamp}`, 'content-type': 'application/json' }, body: JSON.stringify({ eventGroups: [], projectState: true }) });
        expect(await missingState.json()).toMatchObject({ persisted: false, code: 'no_project' });
        const projectsBefore = (await owner(target, '/api/projects')).body;
        const missing = await fetch(`${target.url}${LEGACY_HISTORY_PATH}`, { method: 'POST', headers: { ...target.memberHeaders(), 'x-myco-project': `proj_missing_${stamp}`, 'content-type': 'application/json' }, body: JSON.stringify({ eventGroups: [[eventId]] }) });
        expect((await missing.json() as { confirmed?: boolean }).confirmed).not.toBe(true);
        expect((await owner(target, '/api/projects')).body).toEqual(projectsBefore);
      } finally { await stopMember(target, otherMachine.id); }
    });
  },
};

/** An additive import carries a later vault resolution into an already imported active source. */
export const legacySporeResolution: ParityScenario = {
  name: 'legacy spores: later vault retirement converges and replays once',
  async run(target) {
    await withSettings(target, { 'import.enabled': true }, async () => {
      const id = 'legacy-later-' + crypto.randomUUID();
      const eventId = 'legacy-resolution-' + crypto.randomUUID();
      const post = async (path: string, body: Record<string, unknown>) => {
        const response = await fetch(target.url + path, {
          method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return await response.json() as Record<string, unknown>;
      };
      const vault = { id, agentId: 'user', observationType: 'gotcha', content: 'retire later', status: 'active' };
      let retirement: Record<string, unknown> | null = null;
      const importVault = async () => {
        expect((await post('/spores/save', { channel: 'import', ...vault })).persisted).toBe(true);
        return retirement === null ? null : post('/spores/resolve', {
          channel: 'import', eventId, agentId: 'user', sporeId: id, action: 'obsolete', status: vault.status,
          expectStatus: vault.status, createdAt: 1000, ...retirement,
        });
      };
      const row = async () => { const spore = await mcp(target, 'myco_spores', { op: 'get', id }); return { status: spore.status, revision: spore.revision }; };
      await importVault();
      expect(await row()).toEqual({ status: 'active', revision: 0 });
      vault.status = 'obsolete';
      retirement = { reason: 'retired in vault after import' };
      expect(await importVault()).toEqual({ persisted: true, resolved: true });
      expect(await row()).toEqual({ status: 'obsolete', revision: 1 });
      expect(await importVault()).toEqual({ persisted: true, resolved: true, duplicate: true });
      expect(await row()).toEqual({ status: 'obsolete', revision: 1 });
      const other = id + '-other';
      expect((await post('/spores/save', { channel: 'import', ...vault, id: other, status: 'superseded' })).persisted).toBe(true);
      const refused = await post('/spores/resolve', {
        channel: 'import', eventId: eventId + '-other', agentId: 'user', sporeId: other,
        action: 'obsolete', status: 'obsolete', expectStatus: 'obsolete',
    });
    expect(refused).toMatchObject({ persisted: false, code: 'stale', status: 'superseded', revision: 0 });
    expect(refused.reason).toBe('source is superseded at revision 0; expected obsolete or active');
    });
  },
};
