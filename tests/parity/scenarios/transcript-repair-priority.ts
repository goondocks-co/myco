import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { laneSelectionSql, PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

async function shipSegment(target: ParityTarget, to: { sessionId: string; transcriptId: string }, text: string, baseOffset = 0, agent = 'cursor') {
  const bytes = new TextEncoder().encode(text);
  const digest = await sha256HexOf(bytes);
  await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
    method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.length) }), body: bytes,
  }), 'repair priority blob');
  await expectPersisted(await fetch(`${target.url}/events`, {
    method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: to.sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel: 'cli',
      producer: { adapter: agent, version: '2026.09' }, payload: { transcriptId: to.transcriptId, baseOffset, length: bytes.length, blob: digest, agent } }),
  }), 'repair priority segment');
  return bytes.length;
}

async function wakeTarget(target: ParityTarget) {
  const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
  expect(response.status).toBe(200);
  return await response.json() as { jobs: { name: string; more: boolean; failed: string | null }[] };
}

const MAX_REPAIR_WAKES = 128;

/** Live segment ingestion and bounded repair scheduling through each target's wake path. */
export const transcriptRepairPriority: ParityScenario = {
  name: 'transcript repair priority: fresh live bytes precede a large rewind and repair completes through indexed selections',
  async run(target) {
    const stamp = crypto.randomUUID().replaceAll('-', '');
    const repair = { sessionId: `repair-${stamp}`, transcriptId: `tx_${stamp}` };
    const live = { sessionId: `live-${stamp}`, transcriptId: `tx_${stamp.split('').reverse().join('')}` };
    const record = (text: string, padding = '') => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }] }, padding }) + '\n';
    const history = Array.from({ length: 1_200 }, (_, i) => record(`repair prompt ${i}`, 'x'.repeat(1_000))).join('');
    const ship = (to: typeof repair, text: string) => shipSegment(target, to, text);
    const size = await ship(repair, history);
    await target.sql(`UPDATE transcripts SET parsed_offset = size, parsed_at = last_received_at, parser_version = ${PARSER_VERSION - 1}
      WHERE project_id = ${lit(target.projectId)} AND transcript_id = ${lit(repair.transcriptId)}`);
    await ship(live, record('fresh live prompt'));
    const wake = () => wakeTarget(target);
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
    let previousOffset = Number((await state()).parsed_offset);
    let wakes = 1;
    while (wakes < MAX_REPAIR_WAKES && previousOffset < size) {
      const report = await wake();
      const next = await state();
      expect(report.jobs.find((job) => job.name === 'transcript-parse')?.failed).toBeNull();
      expect(next.parse_error).toBeNull();
      expect(Number(next.parsed_offset)).toBeGreaterThan(previousOffset);
      if (Number(next.parsed_offset) < size) expect(report.jobs.find((job) => job.name === 'transcript-parse')?.more).toBe(true);
      previousOffset = Number(next.parsed_offset);
      wakes += 1;
    }
    console.info(`transcript repair priority: ${target.name}, ${wakes} wakes for 1200 prompts`);
    expect(await state()).toMatchObject({ parsed_offset: size, size, parse_error: null });
    const counts = await target.sql(`SELECT COUNT(*) AS n FROM prompt_batches WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(repair.sessionId)}`);
    expect(Number(counts[0].n)).toBe(1_200);
  },
};

/** Deployed checkpoint ambiguity and durable live service order on each target's own store. */
export const transcriptLiveService: ParityScenario = {
  name: 'transcript live service: equal-time deployed checkpoints, fair indexed selection, and matching pending counts',
  async run(target) {
    const fresh = { sessionId: `chunked-${crypto.randomUUID()}`, transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}` };
    const repair = { sessionId: `older-${crypto.randomUUID()}`, transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}` };
    const short = { sessionId: `short-${crypto.randomUUID()}`, transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}` };
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    const prompt = (text: string) => line({ type: 'user', promptId: crypto.randomUUID(), message: { content: text } });
    const head = prompt('pending large calls') + line({ type: 'assistant', message: { content: Array.from({ length: 8 }, (_, i) =>
      ({ type: 'tool_use', id: `large-${i}`, name: 'Read', input: { path: 'r'.repeat(50_000) } })) } });
    let freshSize = await shipSegment(target, fresh, head, 0, 'claude-code');
    await wakeTarget(target);
    const checkpoint = (await target.sql(`SELECT parser_context, parsed_at FROM transcripts WHERE transcript_id = ${lit(fresh.transcriptId)}`))[0];
    expect(JSON.parse(String(checkpoint.parser_context)).mycoParserState.chunked).toBe(true);
    expect(Number((await target.sql(`SELECT COUNT(*) AS n FROM transcript_parser_state_chunks WHERE transcript_id = ${lit(fresh.transcriptId)}`))[0].n)).toBeGreaterThan(0);
    await target.sql(`UPDATE transcripts SET parser_context = json_remove(parser_context, '$.mycoParserRereadUntil', '$.mycoParserReadSize')
      WHERE transcript_id = ${lit(fresh.transcriptId)}`);
    await shipSegment(target, repair, line({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>older repair</user_query>' }] } }));
    await target.sql(`UPDATE transcripts SET parsed_offset = size, parsed_at = ${Number(checkpoint.parsed_at) - 10_000}, parser_version = ${PARSER_VERSION}
      WHERE transcript_id = ${lit(repair.transcriptId)}`);
    const reread = await fetch(`${target.url}/api/transcripts/reread`, { method: 'POST',
      headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: target.projectId, sessionId: repair.sessionId }) });
    expect(reread.status).toBe(200);
    const report = await reread.json() as { reread: number };
    expect(report).toEqual({ reread: 1 });
    freshSize += await shipSegment(target, fresh, prompt('fresh equal-time bytes'), freshSize, 'claude-code');
    await target.sql(`UPDATE transcripts SET last_received_at = parsed_at WHERE transcript_id = ${lit(fresh.transcriptId)}`);
    const selected = async (lane: 'live' | 'imported' | 'repair') => await target.sql(laneSelectionSql(lane, 10_000).replace('?', String(PARSER_VERSION)));
    expect((await selected('live'))[0]?.transcript_id).toBe(fresh.transcriptId);
    expect((await selected('repair')).some((row) => row.transcript_id === repair.transcriptId)).toBe(true);
    const checkPending = async () => {
      const ids = [];
      for (const lane of ['live', 'imported', 'repair'] as const) ids.push(...(await selected(lane)).map((row) => String(row.transcript_id)));
      expect(new Set(ids).size).toBe(ids.length);
      const response = await fetch(`${target.url}/api/status`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const status = await response.json() as { transcriptBacklog: { transcripts: number } };
      expect(status.transcriptBacklog.transcripts).toBe(ids.length);
    };
    await checkPending();
    await wakeTarget(target);
    expect(await target.sql(`SELECT text FROM prompt_batches WHERE session_id = ${lit(fresh.sessionId)} AND text = 'fresh equal-time bytes'`))
      .toEqual([{ text: 'fresh equal-time bytes' }]);
    let shortSize = await shipSegment(target, short, prompt('initial short'), 0, 'claude-code');
    await wakeTarget(target);
    for (let tick = 0; tick < 3; tick += 1) {
      freshSize += await shipSegment(target, fresh, prompt(`long service ${tick}`), freshSize, 'claude-code');
      await wakeTarget(target);
      freshSize += await shipSegment(target, fresh, prompt(`long growing ${tick}`), freshSize, 'claude-code');
      shortSize += await shipSegment(target, short, prompt(`short growing ${tick}`), shortSize, 'claude-code');
      expect((await selected('live'))[0]?.transcript_id).toBe(short.transcriptId);
      await checkPending();
      await wakeTarget(target);
      expect(await target.sql(`SELECT text FROM prompt_batches WHERE session_id = ${lit(short.sessionId)} AND text = ${lit(`short growing ${tick}`)}`))
        .toEqual([{ text: `short growing ${tick}` }]);
    }
    for (const lane of ['live', 'imported', 'repair'] as const) {
      const plan = await target.sql(`EXPLAIN QUERY PLAN ${laneSelectionSql(lane).replace('?', String(PARSER_VERSION))}`);
      expect(plan.some((row) => /^SEARCH transcripts USING INDEX idx_transcripts_backlog \(imported_at/.test(String(row.detail)))).toBe(true);
    }
    await checkPending();
  },
};
