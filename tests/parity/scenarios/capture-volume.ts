import { expect } from 'bun:test';
import { type ParityScenario, memberHeadersFor } from '../harness.ts';
import { blob, transcript, turns } from '../clients/capture.ts';
import { event, owner } from '../clients/requests.ts';
import { asMember, publishedSession } from '../clients/runs.ts';
import { credentials, joinMachine } from '../historical-storage/clients.ts';

export const captureVolume: ParityScenario = {
  name: 'capture volume: traffic is counted and revocation admits nothing',
  async run(target) {
    const joined = await joinMachine(target);
    const member = asMember(target, joined.token);
    const credential = async () => (await credentials(target)).find(row => row.memberId === joined.memberId && row.machineId === joined.machineId);
    const initial = await credential(); expect(initial).toBeDefined();
    const sessionId = `volume-${crypto.randomUUID()}`;
    await event(member, sessionId, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
    const afterEvent = (await credential()).bytesWritten;
    expect(afterEvent).toBeGreaterThan(initial.bytesWritten);
    const bytes = new TextEncoder().encode(`counted ${sessionId}`);
    await blob(member, bytes);
    expect((await credential()).bytesWritten).toBe(afterEvent + bytes.byteLength);
    await event(member, sessionId, 'prompt', { promptId: crypto.randomUUID(), text: 'counted prompt', origin: 'user' });
    await transcript(member, sessionId, `${JSON.stringify({ type: 'user', message: { content: 'counted transcript' } })}\n`);
    await publishedSession(target, sessionId);
    const before = await turns(target, sessionId);
    const charged = (await credential()).bytesWritten;
    expect((await owner(target, `/api/credentials/${initial.id}/revoke`, { method: 'POST', body: '{}' })).status).toBe(200);
    const headers = memberHeadersFor(joined.token, target.projectId, { 'content-type': 'application/json' });
    expect((await fetch(`${target.url}/events`, { method: 'POST', headers, body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'prompt', createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { promptId: crypto.randomUUID(), text: 'refused', origin: 'user' } }) })).status).toBe(401);
    expect((await fetch(`${target.url}/blobs/${'a'.repeat(64)}`, { method: 'POST', headers, body: 'refused' })).status).toBe(401);
    expect(await turns(target, sessionId)).toEqual(before);
    expect((await credential()).bytesWritten).toBe(charged);
  },
};
