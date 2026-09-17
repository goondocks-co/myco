import { expect } from 'bun:test';
import { SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
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
  async run(target: ParityTarget) {
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
    // A row no object and no row names: what a deletion that hit its bound leaves for the sweep.
    const orphan = '5'.repeat(64);
    await target.sql(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
      SELECT ${lit(target.projectId)}, ${lit(orphan)}, 1, 'text/plain', id, ${stamp}, ${lit(crypto.randomUUID())} FROM member_credentials ORDER BY issued_at LIMIT 1`);

    const tombstone = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${deleted}/tombstone`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}',
    });
    expect(tombstone.status).toBe(200);
    expect(await tombstone.json()).toMatchObject({ applied: true, blobsFreed: 1, blobsLeft: 0 });

    const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(wake.status).toBe(200);
    const { jobs } = (await wake.json()) as { jobs: Array<{ name: string; changed: number; failed: string | null }> };
    expect(SERVER_JOBS.some((job) => job.name === 'transcript-retention')).toBe(true);
    // Earlier scenarios on the same target may have left orphans of their own, so the sweep's count is a floor: the seeded row is at least one of them.
    const retention = jobs.find((job) => job.name === 'transcript-retention');
    expect({ failed: retention?.failed, swept: (retention?.changed ?? 0) >= 1 }).toEqual({ failed: null, swept: true });

    expect(await read(input)).toEqual({ status: 200, text: `tool input ${stamp}` });
    expect(await read(output)).toEqual({ status: 200, text: `tool output ${stamp}` });
    expect((await read(doomed)).status).toBe(404);
    expect((await read(orphan)).status).toBe(404);
    expect(await target.sql(`SELECT key FROM blobs WHERE key IN (${lit(input)}, ${lit(output)}, ${lit(doomed)}, ${lit(orphan)}) ORDER BY key`))
      .toEqual([input, output].sort().map((key) => ({ key })));

    const calls = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${kept}/turns/${promptId}/tool-calls`, { headers: target.ownerHeaders() });
    expect(calls.status).toBe(200);
    const { rows } = (await calls.json()) as { rows: Array<{ toolCallId: string; inputBlobKey: string | null; outputBlobKey: string | null }> };
    expect(rows.map((r) => [r.toolCallId, r.inputBlobKey, r.outputBlobKey])).toEqual([[toolCallId, input, output]]);
  },
};
