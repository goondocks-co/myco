import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';
import { owner, putSetting, resetSetting, wake } from '../clients/requests.ts';

/**
 * The bounded import, identical on both front doors (#1148).
 *
 * Three of this feature's mechanisms are exactly the places the two stores have
 * diverged before, so each is exercised here rather than only in-process:
 *
 *   - the plan route's answers, which read the transcripts a Project holds;
 *   - the parse order: live transcripts and imported ones are selected apart,
 *     each by its own order over a partial index, and an import is read beside
 *     live work rather than behind it;
 *   - the leaf that turns import off, which is an admission fragment composed
 *     into the write path rather than a check in a handler.
 *
 * The bytes are irrelevant to all three, so the transcripts here are one line
 * each: what is asserted is which transcript the tick reads first, and what the
 * plan says about each candidate.
 */
export const importParity: ParityScenario = {
  name: 'bounded import: the plan\'s answers, imports read beside live work, and the off switch',
  async run(target: ParityTarget) {
    const tx = (c: string) => `tx_${c.repeat(32)}`;
    const body = (n: number) => `${JSON.stringify({ type: 'user', promptId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, message: { content: `prompt ${n}` }, timestamp: '2026-09-01T10:00:00Z' })}\n`;

    const ship = async (sessionId: string, transcriptId: string, n: number, channel: 'cli' | 'import') => {
      const bytes = new TextEncoder().encode(body(n));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const blob = await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }, body: bytes,
      });
      expect((await blob.json() as { stored: boolean }).stored).toBe(true);
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel,
          producer: { adapter: 'claude-code', version: '1' },
          payload: { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'claude-code', headHash: 'a'.repeat(64) },
        }),
      });
      await expectPersisted(res, `${channel} segment`);
    };

    const plan = async (candidates: unknown[], over: Record<string, unknown> = {}) => {
      const res = await fetch(`${target.url}/import/plan`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ ...over, candidates }),
      });
      expect(res.status).toBe(200);
      return await res.json() as { persisted: boolean; code?: string; policy?: { windowDays: number }; candidates?: Array<{ transcriptId: string; take: string; reason?: string; fromOffset?: number }> };
    };

    const candidate = (sessionId: string, transcriptId: string, over: Record<string, unknown> = {}) =>
      ({ sessionId, transcriptId, agent: 'claude-code', sizeBytes: 4000, modifiedAt: Date.now(), headHash: 'a'.repeat(64), ...over });

    // One imported transcript, received first and oldest, and one live one.
    await ship('parity-import', tx('a'), 1, 'import');
    await ship('parity-live', tx('b'), 2, 'cli');

    // The plan reads what the Project holds. Both shipped transcripts resume from
    // what was shipped; a transcript the Project has not seen starts at the beginning.
    const answers = await plan([
      candidate('parity-import', tx('a')),
      candidate('parity-live', tx('b')),
      candidate('parity-new', tx('c')),
      candidate('parity-old', tx('d'), { modifiedAt: Date.now() - 90 * 86_400_000 }),
    ]);
    const byId = new Map((answers.candidates ?? []).map((a) => [a.transcriptId, a]));
    expect(byId.get(tx('c'))).toEqual({ transcriptId: tx('c'), take: 'from', fromOffset: 0 });
    expect(byId.get(tx('d'))?.reason).toBe('window');
    expect(byId.get(tx('a'))?.take).toBe('from');
    expect(byId.get(tx('a'))?.fromOffset).toBeGreaterThan(0);
    expect(byId.get(tx('b'))?.take).toBe('from');
    expect(byId.get(tx('b'))?.fromOffset).toBeGreaterThan(0);

    // A caller may ask past the Deployment's window.
    expect((await plan([candidate('parity-old', tx('d'), { modifiedAt: Date.now() - 90 * 86_400_000 })], { windowDays: 180 })).candidates?.[0].take).toBe('from');

    // The tick publishes an import beside live work, on both stores, within a few wakes. This database is shared with
    // every other scenario, so what one wake reaches is not asserted; that both are published soon is.
    const promptVisible = async (sessionId: string, text: string) => {
      const page = await owner<{ rows?: Array<{ preview: string | null }> }>(target, `/api/projects/${target.projectId}/sessions/${sessionId}/turns`);
      return page.status === 200 && (page.body.rows ?? []).some((row) => row.preview?.includes(text) === true);
    };
    for (let attempt = 0; attempt < 8 && (!(await promptVisible('parity-import', 'prompt 1')) || !(await promptVisible('parity-live', 'prompt 2'))); attempt += 1) {
      await wake(target);
    }
    expect({ imported: await promptVisible('parity-import', 'prompt 1'), live: await promptVisible('parity-live', 'prompt 2') }).toEqual({ imported: true, live: true });

    // The switch is an admission on the write path: with it off, an import-channel
    // write stores nothing and the plan refuses. The leaf is put back for the scenarios that follow.
    expect((await putSetting(target, 'import.enabled', false)).status).toBe(200);
    try {
      const refused = await plan([candidate('parity-new', tx('c'))]);
      expect({ persisted: refused.persisted, code: refused.code }).toEqual({ persisted: false, code: 'import_disabled' });
      const bytes = new TextEncoder().encode(body(9));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await fetch(`${target.url}/blobs/${digest}`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }, body: bytes });
      const write = await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: crypto.randomUUID(), sessionId: 'parity-off', kind: 'transcript.segment', createdAt: Date.now(), channel: 'import',
          producer: { adapter: 'claude-code', version: '1' },
          payload: { transcriptId: tx('e'), baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'claude-code' },
        }),
      });
      expect(await write.json()).toMatchObject({ persisted: false, code: 'import_disabled' });
      expect((await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent('parity-off')}`)).status).toBe(404);
    } finally {
      expect((await resetSetting(target, 'import.enabled')).status).toBe(200);
    }
    const held = await plan([candidate('parity-off', tx('e'))]);
    expect(held.candidates?.[0]).toEqual({ transcriptId: tx('e'), take: 'from', fromOffset: 0 });
    expect((await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent('parity-off')}`)).status).toBe(404);
  },
};
