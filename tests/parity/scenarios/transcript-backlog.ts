import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const cursorLine = (role: string, text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`;

/**
 * A transcript backlog on both targets: what the dashboard and the tick count as waiting to be read, a wake that
 * says whether its parse left work, an import and a live transcript both read to their end, and undated lines dated
 * by their place in their segment, one store's rows identical to the other's.
 */
export const transcriptBacklog: ParityScenario = {
  name: 'transcript backlog: counted in bytes, reported by each wake, drained beside live work, and dated by line',
  async run(target: ParityTarget) {
    const stamp = crypto.randomUUID().replaceAll('-', '');
    const imported = { sessionId: `backlog-import-${stamp}`, transcriptId: `tx_${stamp}` };
    const live = { sessionId: `backlog-live-${stamp}`, transcriptId: `tx_${stamp.split('').reverse().join('')}` };
    const sentAt = Date.now() - 120_000;
    const turns = 30;
    let history = '';
    for (let i = 0; i < turns; i += 1) history += cursorLine('user', `<user_query>\nbacklog question ${i}\n</user_query>`) + cursorLine('assistant', `backlog answer ${i}`);

    const ship = async (to: { sessionId: string; transcriptId: string }, text: string, channel: 'cli' | 'import') => {
      const bytes = new TextEncoder().encode(text);
      const digest = await sha256HexOf(bytes);
      await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
      }), 'segment blob');
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          eventId: crypto.randomUUID(), sessionId: to.sessionId, kind: 'transcript.segment', createdAt: sentAt, channel,
          producer: { adapter: 'cursor', version: '2026.09' },
          payload: { transcriptId: to.transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'cursor' },
        }),
      }), `${channel} segment`);
      return bytes.byteLength;
    };
    const importedBytes = await ship(imported, history, 'import');
    await ship(live, cursorLine('user', '<user_query>\nlive question\n</user_query>') + cursorLine('assistant', 'live answer'), 'cli');

    // The dashboard reads what is waiting in the tick's own count, bytes included.
    const status = await (await fetch(`${target.url}/api/status`, { headers: target.ownerHeaders() })).json() as { transcriptBacklog: { transcripts: number; bytes: number; imported: { transcripts: number; bytes: number } } };
    expect(status.transcriptBacklog.transcripts).toBeGreaterThanOrEqual(2);
    expect(status.transcriptBacklog.imported.transcripts).toBeGreaterThanOrEqual(1);
    expect(status.transcriptBacklog.imported.bytes).toBeGreaterThanOrEqual(importedBytes);

    // Each wake says whether its parse left work, and what it counted waiting once it ran.
    const state = async (id: string) => (await target.sql(`SELECT parsed_offset, size, parse_error, parse_segment_lines FROM transcripts WHERE transcript_id=${lit(id)}`))[0];
    for (let wake = 0; wake < 12; wake += 1) {
      const report = await (await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } })).json() as {
        jobs: { name: string; more: boolean }[]; backlog: { transcripts: number; bytes: number }; nextWakeMs: number | null;
      };
      const parse = report.jobs.find((j) => j.name === 'transcript-parse');
      expect(typeof parse?.more).toBe('boolean');
      expect(typeof report.backlog.bytes).toBe('number');
      const [a, b] = [await state(imported.transcriptId), await state(live.transcriptId)];
      if (Number(a.parsed_offset) === Number(a.size) && Number(b.parsed_offset) === Number(b.size)) break;
    }
    expect(await state(imported.transcriptId)).toMatchObject({ parsed_offset: importedBytes, parse_error: null, parse_segment_lines: 0 });
    expect(Number((await state(live.transcriptId)).parsed_offset)).toBe(Number((await state(live.transcriptId)).size));

    // Every undated line takes its segment's time plus its place in the segment.
    const prompts = await target.sql(`SELECT text, created_at FROM prompt_batches WHERE project_id=${lit(target.projectId)} AND session_id=${lit(imported.sessionId)} ORDER BY created_at`);
    expect(prompts.map((p) => ({ text: p.text, at: Number(p.created_at) }))).toEqual(
      Array.from({ length: turns }, (_, i) => ({ text: `backlog question ${i}`, at: sentAt + 2 * i })),
    );
  },
};
