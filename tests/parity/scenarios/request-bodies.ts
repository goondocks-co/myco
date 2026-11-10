import { expect } from 'bun:test';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A request body near the body cap is taken whole, and a streamed body past it is refused in the route's shape, on
 * both targets. The Worker runs on V8, where a call taking one argument per byte throws past about 125k arguments and a
 * handler may not cancel or release the request stream the runtime owns; Bun tolerates both, so only the Worker target
 * shows either.
 */
export const requestBodies: ParityScenario = {
  name: 'request bodies: a body near the cap is stored whole and a streamed body past it is refused, on the Worker as on Bun',
  async run(target: ParityTarget) {
    const now = Date.now();
    const sessionId = `parity-request-bodies-${now}-${crypto.randomUUID()}`;
    const event = (payload: Record<string, unknown>, kind = 'prompt') =>
      JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: now, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload });
    const post = (body: BodyInit, extra: RequestInit = {}) => fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body, ...extra,
    });
    await expectPersisted(await post(event({ agent: 'claude-code', startedAt: now }, 'session.start')), 'session start');

    const near = event({ promptId: crypto.randomUUID(), text: 'a'.repeat(200_000), origin: 'user' });
    expect(new TextEncoder().encode(near).byteLength).toBeGreaterThan(200_000);
    await expectPersisted(await post(near), 'a body near the cap');

    const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
    let sent = 0;
    const past = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) { controller.close(); return; }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const refused = await post(past, { duplex: 'half' } as RequestInit);
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 200, body: { persisted: false, reason: expect.stringContaining(`the limit is ${MAX_BODY_BYTES} bytes`) } });

    await expectPersisted(await post(event({ promptId: crypto.randomUUID(), text: 'after', origin: 'user' })), 'the request after a refused stream');
  },
};
