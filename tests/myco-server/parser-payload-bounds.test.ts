import { continuityRecords } from './helpers/continuity-records.js';
import { MAX_BLOB_BYTES } from '@myco-server-worker/constants.js';
import { describe, expect, it } from 'bun:test';
import { utf8 } from '@myco-server-worker/hash.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { READ_BEFORE_PIN } from '@myco-server-worker/ingest/prompt-scheme.js';
import type { ParsedLine, ParserState } from '@myco-server-worker/ingest/parsers/index.js';

const SESSION = '01932bd0-0000-7000-8000-00000000ab01';
const NOW = Date.parse('2026-09-08T12:00:00Z');
const TIME = '2026-09-08T11:00:00Z';

function linesOf(values: Record<string, unknown>[]): ParsedLine[] {
  let offset = 0;
  return values.map((value) => {
    const line = { value, offset };
    offset += utf8(JSON.stringify(value) + '\n').byteLength;
    return line;
  });
}

describe('registered production view parsing', () => {
  for (const [encoding, huge] of [['ASCII', 'A'.repeat(300_000)], ['Unicode', '🌱'.repeat(90_000)], ['JSON escapes', '\\\"\n'.repeat(100_000)]]) {
    for (const [agent, records] of Object.entries(continuityRecords)) {
      it(`${agent} preserves large ${encoding} view fields through the next turn`, async () => {
        const values = JSON.parse(JSON.stringify(records), (key, value) => {
          if (key === 'arguments') return JSON.stringify({ path: huge });
          if (['start', 'first', 'a'].includes(value)) return huge;
          return typeof value === 'string' ? value.replace('# First', `# Large plan\n${huge}`) : value;
        });
        const events = await PARSERS[agent].parse({ view: true, transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1',
          scheme: READ_BEFORE_PIN[agent]!, sessionId: SESSION, now: NOW, lines: linesOf(values) });
        expect(events.filter(event => event.kind === 'prompt').map(event => String(event.payload.text).trim())).toEqual([huge.trim(), 'later']);
        expect(events.some(event => event.kind === 'response' && String(event.payload.text).includes(huge.trim()))).toBe(true);
        if (agent !== 'cursor') expect(events.find(event => event.kind === 'tool.use')?.payload.input).toEqual({ path: huge });
        if (agent === 'claude-code' || agent === 'codex') expect(String(events.find(event => event.kind === 'plan')?.payload.content).includes(huge.trim())).toBe(true);
      });
    }
  }

  it('retains pending view input until its byte budget, then records a pending-limit failure', async () => {
    const state: ParserState = {};
    const parse = (content: string, id: string) => PARSERS['claude-code'].parse({ view: true, transcriptId: 'tx_legacy_fixture',
      recordScheme: 'legacy-session-v1', scheme: 'claude-v1', sessionId: SESSION, now: NOW, state, lines: linesOf([
        { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { content } }] }, timestamp: TIME },
      ]) });
    const content = 'x'.repeat(MAX_BLOB_BYTES / 2);
    await parse(content, 'first');
    expect(state.pending?.first.input).toEqual({ content });
    const events = await parse(content, 'second');
    expect(events.find(event => event.kind === 'tool.failure')?.payload).toMatchObject({ resultReason: 'pending_limit', input: { content } });
    expect(Object.keys(state.pending ?? {})).toEqual(['second']);
  });

  it('retains deep view tool input independently of the ingest envelope', async () => {
    let input: unknown = { leaf: 'ok' };
    for (let depth = 0; depth < 40; depth += 1) input = { nested: input };
    const events = await PARSERS.cline.parse({ view: true, transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, scheme: 'stamp-or-offset-v1',  sessionId: SESSION, now: NOW, lines: linesOf([
      { v: 1, type: 'prompt', promptId: SESSION, text: 'first prompt', at: TIME },
      { v: 1, type: 'tool', name: 'read', input, failed: false, at: TIME },
      { v: 1, type: 'prompt', promptId: SESSION, text: 'later valid prompt', at: TIME },
    ]) });
    expect(events.find((event) => event.kind === 'tool.use')?.payload.input).toEqual(input);
  });
});

it('view parsing retains a reply at the document limit and refuses one byte beyond it', async () => {
  const parse = (text: string) => PARSERS.cline.parse({ view: true, transcriptId: 'view-limit', recordScheme: 'legacy-session-v1',
    scheme: 'stamp-or-offset-v1', sessionId: SESSION, now: NOW,
    lines: linesOf([{ v: 1, type: 'response', text, at: TIME }]) });
  const text = 'x'.repeat(MAX_BLOB_BYTES);
  const events = await parse(text);
  expect(events.find(event => event.kind === 'response')?.payload.text).toBe(text);
  await expect(parse(text + 'x')).rejects.toThrow('view_record_too_large');
});
