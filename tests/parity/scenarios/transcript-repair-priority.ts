import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { laneSelectionSql, PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';

/** Live segment ingestion and bounded repair scheduling through each target's wake path. */
export const transcriptRepairPriority: ParityScenario = {
  name: 'transcript repair priority: fresh live bytes precede a large rewind and repair completes through indexed selections',
  async run(target) {
    const stamp = crypto.randomUUID().replaceAll('-', '');
    const repair = { sessionId: `repair-${stamp}`, transcriptId: `tx_${stamp}` };
    const live = { sessionId: `live-${stamp}`, transcriptId: `tx_${stamp.split('').reverse().join('')}` };
    const record = (text: string, padding = '') => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }] }, padding }) + '\n';
    const history = Array.from({ length: 1_200 }, (_, i) => record(`repair prompt ${i}`, 'x'.repeat(1_000))).join('');
    const ship = async (to: typeof repair, text: string) => {
      const bytes = new TextEncoder().encode(text);
      const digest = await sha256HexOf(bytes);
      await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.length) }), body: bytes,
      }), 'repair priority blob');
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: to.sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel: 'cli',
          producer: { adapter: 'cursor', version: '2026.09' }, payload: { transcriptId: to.transcriptId, baseOffset: 0, length: bytes.length, blob: digest, agent: 'cursor' } }),
      }), 'repair priority segment');
      return bytes.length;
    };
    const size = await ship(repair, history);
    await target.sql(`UPDATE transcripts SET parsed_offset = size, parsed_at = last_received_at, parser_version = ${PARSER_VERSION - 1}
      WHERE project_id = ${lit(target.projectId)} AND transcript_id = ${lit(repair.transcriptId)}`);
    await ship(live, record('fresh live prompt'));
    const wake = async () => {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
      return await response.json() as { jobs: { name: string; more: boolean }[] };
    };
    const state = async () => (await target.sql(`SELECT parsed_offset, size, parse_error FROM transcripts
      WHERE project_id = ${lit(target.projectId)} AND transcript_id = ${lit(repair.transcriptId)}`))[0];
    const first = await wake();
    expect(await target.sql(`SELECT text FROM prompt_batches WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(live.sessionId)}`))
      .toEqual([{ text: 'fresh live prompt' }]);
    expect(Number((await state()).parsed_offset)).toBeLessThan(size);
    expect(first.jobs.find((job) => job.name === 'transcript-parse')?.more).toBe(true);
    for (const lane of ['live', 'imported', 'repair'] as const) {
      const plan = await target.sql(`EXPLAIN QUERY PLAN ${laneSelectionSql(lane).replace('?', String(PARSER_VERSION))}`);
      expect(plan.some((row) => /^SEARCH transcripts USING INDEX idx_transcripts_backlog \(imported_at/.test(String(row.detail)))).toBe(true);
    }
    for (let tick = 0; tick < 12 && Number((await state()).parsed_offset) < size; tick += 1) await wake();
    expect(await state()).toMatchObject({ parsed_offset: size, size, parse_error: null });
    const counts = await target.sql(`SELECT COUNT(*) AS n FROM prompt_batches WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(repair.sessionId)}`);
    expect(Number(counts[0].n)).toBe(1_200);
  },
};
