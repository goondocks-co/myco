import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A tool call's spilled input and output on both targets: a deletion beside
 * them wakes the orphan sweep, the sweep frees the blob nothing holds and the
 * one the deleted session held, and the tool call's own bytes still come back
 * through the reader, byte for byte, with the tool-call row still naming them.
 */
export const toolBlobRetention: ParityScenario = {
  name: 'tool-call blobs: kept by the orphan sweep while referenced, read back whole; the deleted session\'s and the unreferenced freed',
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    // The orphan audit arms at its first pass and releases only uploads received after it: arm it now, on the clock path that runs it.
    if (target.clockAlarm !== undefined) await target.clockAlarm(Date.now()); else await target.clockWake();
    const stamp = Date.now();
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const upload = async (text: string): Promise<string> => {
      const bytes = new TextEncoder().encode(text);
      const key = await sha256Hex(bytes);
      const res = await fetch(`${target.url}/blobs/${key}`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) },
        body: bytes,
      });
      await expectPersisted(res, `blob ${text}`);
      return key;
    };
    const read = async (key: string): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/blobs/${key}`, { headers: target.ownerHeaders() });
      return { status: res.status, text: await res.text() };
    };

    const input = await upload(`tool input ${stamp}`);
    const output = await upload(`tool output ${stamp}`);
    const doomed = await upload(`deleted session's attachment ${stamp}`);
    const kept = `parity-tool-blobs-${stamp}`;
    const deleted = `parity-tool-blobs-deleted-${stamp}`;
    const promptId = crypto.randomUUID();
    const toolCallId = crypto.randomUUID();
    await post(kept, 'session.start', { agent: 'claude-code', startedAt: stamp });
    await post(kept, 'prompt', { promptId, text: `spill ${stamp}`, origin: 'user' });
    await post(kept, 'tool.use', { toolCallId, promptId, toolName: 'Read', blob: input, outputBlob: output, success: true });
    await post(deleted, 'session.start', { agent: 'claude-code', startedAt: stamp });
    await post(deleted, 'attachment', { attachmentId: crypto.randomUUID(), blob: doomed, description: 'goes with its session' });
    const orphan = await upload(`upload without an event ${stamp}`);
    const tombstone = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${deleted}/tombstone`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}',
    });
    expect(tombstone.status).toBe(202);
    await tombstone.body?.cancel();

    const future = stamp + 3 * 86_400_000;
    for (let pass = 0; pass < 12; pass++) {
      if (target.clockAlarm !== undefined) await target.clockAlarm(future + pass * 86_400_000);
      else await target.clockWake(future + pass * 86_400_000);
      if ((await read(doomed)).status === 404 && (await read(orphan)).status === 404) break;
    }

    expect(await read(input)).toEqual({ status: 200, text: `tool input ${stamp}` });
    expect(await read(output)).toEqual({ status: 200, text: `tool output ${stamp}` });
    expect((await read(doomed)).status).toBe(404);
    expect((await read(orphan)).status).toBe(404);
    // Stored deletion witnesses distinguish reclaimed registrations from hidden HTTP resources.
    expect(await target.sql(`SELECT key FROM blobs WHERE key IN (${lit(input)}, ${lit(output)}, ${lit(doomed)}, ${lit(orphan)}) ORDER BY key`))
      .toEqual([input, output].sort().map((key) => ({ key })));
  },
};
