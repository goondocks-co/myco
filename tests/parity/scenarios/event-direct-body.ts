import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario } from '../harness.ts';
import { event } from '../clients/requests.ts';
import { publishedTurns, turn } from '../clients/capture.ts';

/** Large captured bodies stay readable and replay does not create another turn. */
export const eventDirectBody: ParityScenario = {
  name: 'event intake: a large prompt is readable in full and a replay lands once',
  async run(target) {
    const sessionId = `direct-body-${crypto.randomUUID()}`, now = Date.now();
    await event(target, sessionId, 'session.start', { agent: 'claude-code', startedAt: now });
    // The 24 KB Unicode body exceeds EVENT_INLINE_PAYLOAD_BYTES (16 KB).
    const payload = { promptId: crypto.randomUUID(), text: 'é'.repeat(12_000), origin: 'user' };
    const body = JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'prompt', createdAt: now, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload });
    const post = () => fetch(`${target.url}/events`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body });
    await expectPersisted(await post(), 'large prompt');
    expect(await (await post()).json()).toEqual({ persisted: true, duplicate: true });
    const page = await publishedTurns(target, sessionId, rows => rows.length === 1);
    expect(page.body.rows.map((row: any) => row.promptId)).toEqual([payload.promptId]);
    expect((await turn(target, sessionId, payload.promptId)).body.prompt.text).toBe(payload.text);
  },
};
