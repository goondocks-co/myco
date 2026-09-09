import { expect } from 'bun:test';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The bounded import, identical on both front doors (#1148).
 *
 * Three of this feature's mechanisms are exactly the places the two stores have
 * diverged before, so each is exercised here rather than only in-process:
 *
 *   - the plan route's answers, which read the transcripts a Project holds and
 *     the room a credential has left;
 *   - the parse order, which rests on a partial index and on NULLs sorting
 *     first in an ascending key;
 *   - the leaf that turns import off, which is an admission fragment composed
 *     into the write path rather than a check in a handler.
 *
 * The bytes are irrelevant to all three, so the transcripts here are one line
 * each: what is asserted is which transcript the tick reads first, and what the
 * plan says about each candidate.
 */
export const importParity: ParityScenario = {
  name: 'bounded import: the plan\'s answers, live-before-imported parse order, and the off switch',
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

    const lanes = await target.sql(`SELECT transcript_id, imported_at IS NOT NULL AS imported FROM transcripts WHERE transcript_id IN (${lit(tx('a'))}, ${lit(tx('b'))}) ORDER BY transcript_id`);
    expect(lanes.map((r) => Number(r.imported))).toEqual([1, 0]);

    // The plan reads what the Project holds. The imported transcript is held in
    // full at 4000 bytes on neither store, so it resumes from what was shipped.
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

    // A caller may ask past the Deployment's window.
    expect((await plan([candidate('parity-old', tx('d'), { modifiedAt: Date.now() - 90 * 86_400_000 })], { windowDays: 180 })).candidates?.[0].take).toBe('from');

    // The tick reads live transcripts before imported ones, on both stores. The
    // order rests on NULLs sorting first in an ascending key over a partial
    // index, which is exactly the kind of thing the two stores have differed on.
    //
    // Asserted as the invariant rather than as "the live one is parsed after
    // one wake": this database is shared with every other scenario, so what a
    // single tick reaches is not a property of this feature. What IS a property
    // of it is that no imported transcript is ever read while live work waits.
    const parsed = async (id: string) => Number((await target.sql(`SELECT parsed_offset FROM transcripts WHERE transcript_id=${lit(id)}`))[0].parsed_offset);
    const livePending = async () => Number((await target.sql(`SELECT COUNT(*) AS n FROM transcripts WHERE imported_at IS NULL AND parsed_offset < size AND parse_error IS NULL`))[0].n);
    for (let wake = 0; wake < 8; wake += 1) {
      await fetch(`${target.url}/api/wake`, { method: 'POST', headers: target.ownerHeaders() });
      expect({ wake, jumpedTheQueue: (await parsed(tx('a'))) > 0 && (await livePending()) > 0 }).toEqual({ wake, jumpedTheQueue: false });
    }
    // That a deferred backfill is eventually READ is a claim about throughput
    // rather than about parity, and this database is shared with every other
    // scenario — so it is asserted where the fixture is controlled, in
    // `tests/myco-server/import-backfill.test.ts`.

    // The switch is an admission on the write path, not a check in a handler:
    // with it off, an import-channel write stores nothing and the plan refuses.
    await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('import.enabled', ${lit(JSON.stringify(false))}, 1, ${lit(MEMBER_ID)})`);
    const refused = await plan([candidate('parity-new', tx('c'))]);
    expect({ persisted: refused.persisted, code: refused.code }).toEqual({ persisted: false, code: 'import_disabled' });

    const before = Number((await target.sql(`SELECT COUNT(*) AS n FROM events`))[0].n);
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
    expect(Number((await target.sql(`SELECT COUNT(*) AS n FROM events`))[0].n)).toBe(before);

    // This database is shared with every other scenario, and a leaf left off is
    // a switch the next scenario inherits. Put it back.
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'import.enabled'`);
  },
};
