import { expect } from 'bun:test';
import { EVENT_INLINE_PAYLOAD_BYTES } from '@myco-server-worker/ingest/event-payload.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * An event payload over the inline ceiling is held whole in the object store on both targets: the row keeps what its
 * relational readers need, a replay lands once, and a payload at the ceiling stays inline.
 */
export const eventDirectBody: ParityScenario = {
  name: 'event intake: a payload over the inline ceiling is stored whole in the object store; a replay lands once',
  async run(target: ParityTarget) {
    const now = Date.now();
    const sessionId = `parity-direct-body-${now}-${crypto.randomUUID()}`;
    const post = (eventId: string, payload: Record<string, unknown>, kind = 'prompt') => fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ eventId, sessionId, kind, createdAt: now, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
    });
    await expectPersisted(await post(crypto.randomUUID(), { agent: 'claude-code', startedAt: now }, 'session.start'), 'session start');
    const fixed = JSON.stringify({ promptId: crypto.randomUUID(), text: '', origin: 'user' }).length;
    const smallId = crypto.randomUUID();
    await expectPersisted(await post(smallId, { promptId: crypto.randomUUID(), text: 'a'.repeat(EVENT_INLINE_PAYLOAD_BYTES - fixed), origin: 'user' }), 'at the ceiling');
    const eventId = crypto.randomUUID();
    const payload = { promptId: crypto.randomUUID(), text: 'é'.repeat(EVENT_INLINE_PAYLOAD_BYTES), origin: 'user' };
    await expectPersisted(await post(eventId, payload), 'over the ceiling');
    const replay = await (await post(eventId, payload)).json() as { persisted: boolean; duplicate?: boolean };
    expect(replay).toEqual({ persisted: true, duplicate: true });

    const [small] = await target.sql(`SELECT payload_format FROM events WHERE event_id = ${lit(smallId)}`);
    expect(small).toEqual({ payload_format: 'inline' });
    const [row] = await target.sql(`SELECT e.payload_format, e.payload, p.size, p.digest, b.size AS registered_size
      FROM events e JOIN registered_content_proofs p ON p.project_id = e.project_id AND p.source_kind = 'event' AND p.source_id = e.event_id
      JOIN blobs b ON b.project_id = p.project_id AND b.key = p.key WHERE e.event_id = ${lit(eventId)}`);
    const body = new TextEncoder().encode(JSON.stringify(payload));
    expect(row).toMatchObject({ payload_format: 'blob', size: body.byteLength, registered_size: body.byteLength });
    expect(JSON.parse(String(row!.payload))).toEqual({ promptId: payload.promptId, origin: 'user' });
    expect(await target.sql(`SELECT COUNT(*) AS n FROM events WHERE session_id = ${lit(sessionId)}`)).toEqual([{ n: 3 }]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM blob_reservations WHERE source_event_id = ${lit(eventId)}`)).toEqual([{ n: 0 }]);
  },
};
