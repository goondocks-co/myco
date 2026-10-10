import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { PARSER_VERSION, PARSE_STOP_GENERATION, TRANSCRIPT_PARSE_MALFORMED_LIMIT } from '@myco-server-worker/ingest/parse.js';
import { expectPersisted, lit, type ParityTarget } from '../harness.ts';

export async function verifyTranscriptParserStop(target: ParityTarget): Promise<void> {
  const recording = async (text: string, splitAt?: number) => {
    const sessionId = `parser-stop-${crypto.randomUUID()}`;
    const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    const bytes = new TextEncoder().encode(text);
    const slices = splitAt === undefined ? [{ baseOffset: 0, slice: bytes }]
      : [{ baseOffset: 0, slice: bytes.subarray(0, splitAt) }, { baseOffset: splitAt, slice: bytes.subarray(splitAt) }];
    for (const { baseOffset, slice } of slices) {
      const digest = await sha256HexOf(slice);
      await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(slice.length) }), body: slice,
      }), 'synthetic transcript bytes');
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', channel: 'cli',
          createdAt: Date.now(), producer: { adapter: 'claude-code', version: 'test' },
          payload: { transcriptId, agent: 'claude-code', blob: digest, baseOffset, length: slice.length } }),
      }), 'synthetic transcript segment');
    }
    return { sessionId, bytes, where: `project_id=${lit(target.projectId)} AND transcript_id=${lit(transcriptId)}` };
  };
  const text = [
    { type: 'user', promptId: crypto.randomUUID(), message: { content: 'synthetic prompt' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic reply' }] } },
  ].map((record) => JSON.stringify(record) + '\n').join('');
  const { sessionId, bytes, where } = await recording(text);
  const wake = async () => {
    const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(response.status).toBe(200);
  };
  await wake();
  const completed = await target.sql(`SELECT parsed_offset,parser_version,parser_context,parsed_at FROM transcripts WHERE ${where}`);
  await wake();
  expect(await target.sql(`SELECT parsed_offset,parser_version,parser_context,parsed_at FROM transcripts WHERE ${where}`)).toEqual(completed);
  const diagnostic = { branch: 'no_progress', offset: 0, lineKind: 'user' };
  await target.sql(`UPDATE transcripts SET parsed_offset=0, parse_segment_lines=0, open_prompt_id=NULL, parse_error='parse', parse_failed_at=9999999999999,
    parser_version=${PARSER_VERSION}, parser_context=${lit(JSON.stringify({ mycoParserFailure: { ...diagnostic, generation: PARSE_STOP_GENERATION } }))} WHERE ${where}`);
  const attention = await fetch(`${target.url}/api/attention`, { headers: target.ownerHeaders() });
  expect(attention.status).toBe(200);
  const answer = await attention.json() as { items: { kind: string; projectId?: string; latestDiagnostic?: unknown }[] };
  expect(answer.items.find((item) => item.kind === 'transcripts_stopped' && item.projectId === target.projectId)?.latestDiagnostic).toEqual(diagnostic);
  await wake();
  expect(await target.sql(`SELECT parsed_offset,parse_error FROM transcripts WHERE ${where}`)).toEqual([{ parsed_offset: 0, parse_error: 'parse' }]);
  await target.sql(`UPDATE transcripts SET parser_context=json_remove(parser_context,'$.mycoParserFailure.generation') WHERE ${where}`);
  for (let pass = 0; pass < 8; pass += 1) {
    await wake();
    const row = (await target.sql(`SELECT parsed_offset FROM transcripts WHERE ${where}`))[0];
    if (row.parsed_offset === bytes.length) break;
  }
  expect(await target.sql(`SELECT parsed_offset,parse_error,json_extract(parser_context,'$.mycoParserFailure') AS diagnostic FROM transcripts WHERE ${where}`))
    .toEqual([{ parsed_offset: bytes.length, parse_error: null, diagnostic: null }]);
  const prompt = (await target.sql(`SELECT prompt_id FROM prompt_batches WHERE project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`))[0];
  expect(await target.sql(`SELECT open_prompt_id FROM transcripts WHERE ${where}`)).toEqual([{ open_prompt_id: prompt.prompt_id }]);
  expect(await target.sql(`SELECT text FROM prompt_batches WHERE project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`))
    .toEqual([{ text: 'synthetic prompt' }]);
  const malformed = await recording('not-json\n'.repeat(TRANSCRIPT_PARSE_MALFORMED_LIMIT + 1));
  await wake();
  expect(await target.sql(`SELECT parse_error,json_extract(parser_context,'$.mycoParserFailure') AS diagnostic FROM transcripts WHERE ${malformed.where}`))
    .toEqual([{ parse_error: 'parse', diagnostic: JSON.stringify({ branch: 'malformed_lines', offset: 0, lineKind: 'unknown', generation: PARSE_STOP_GENERATION }) }]);
  const stopped = await target.sql(`SELECT parse_failed_at,parser_context FROM transcripts WHERE ${malformed.where}`);
  await wake();
  expect(await target.sql(`SELECT parse_failed_at,parser_context FROM transcripts WHERE ${malformed.where}`)).toEqual(stopped);

  const cursor = new TextEncoder().encode(text.split('\n')[0] + '\n').length;
  const pruned = await recording(text, cursor);
  await wake();
  await target.sql(`DELETE FROM transcript_segments WHERE ${pruned.where} AND base_offset=0`);
  await target.sql(`UPDATE transcripts SET parsed_offset=${cursor},parser_version=${PARSER_VERSION - 1},parse_error='parse',parse_failed_at=1,
    parse_awaited_size=size WHERE ${pruned.where}`);
  for (let pass = 0; pass < 8; pass += 1) {
    await wake();
    if ((await target.sql(`SELECT parsed_offset FROM transcripts WHERE ${pruned.where}`))[0].parsed_offset === pruned.bytes.length) break;
  }
  expect(await target.sql(`SELECT parsed_offset,parse_error,parse_failed_at,parse_awaited_size,
    json_extract(parser_context,'$.mycoParserRepair.status') AS repair FROM transcripts WHERE ${pruned.where}`))
    .toEqual([{ parsed_offset: pruned.bytes.length, parse_error: null, parse_failed_at: null, parse_awaited_size: null, repair: 'raw_prefix_pruned' }]);
}
