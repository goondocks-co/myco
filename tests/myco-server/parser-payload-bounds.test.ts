import { describe, expect, it } from 'bun:test';
import { utf8 } from '@myco-server-worker/hash.js';
import { MAX_PAYLOAD_BYTES, parseEnvelope } from '@myco-server-worker/ingest/envelope.js';
import { kindSpec, parsePayload } from '@myco-server-worker/ingest/kinds.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import type { DerivedEvent, ParsedLine } from '@myco-server-worker/ingest/parsers/index.js';

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

function expectAdmitted(events: DerivedEvent[]): void {
  for (const event of events) {
    const spec = kindSpec(event.kind);
    expect(spec).toBeDefined();
    if (spec === null) throw new Error(`no kind ${event.kind}`);
    expect({ kind: event.kind, parsed: parsePayload(spec, event.payload, NOW) }).toMatchObject({ kind: event.kind, parsed: { ok: true } });
    expect(utf8(JSON.stringify(event.payload)).byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(parseEnvelope({
      eventId: SESSION,
      sessionId: SESSION,
      kind: event.kind,
      createdAt: event.createdAt,
      channel: 'http',
      producer: { adapter: 'server', version: '1' },
      payload: event.payload,
    }, NOW)).toMatchObject({ ok: true });
  }
}

describe('registered parser payload admission', () => {
  it('retains admissible tool input by shortening an output preview before omitting input', async () => {
    const input = { content: 'x'.repeat(MAX_PAYLOAD_BYTES - 500) };
    const events = await PARSERS.cline.parse({ sessionId: SESSION, now: NOW, lines: linesOf([
      { v: 1, type: 'tool', name: 'read', input, output: 'o'.repeat(4096), failed: false, at: TIME },
    ]) });
    expectAdmitted(events);
    expect(events[0].payload.input).toEqual(input);
    expect(events[0].payload.output).toContain('not kept');
  });
  for (const [label, oversized] of [
    ['ASCII', 'A'.repeat(300_000)],
    ['Unicode', '🌱'.repeat(90_000)],
    ['JSON escapes', '\\"\n'.repeat(100_000)],
  ] as const) {
    it(`keeps later Claude turns after oversized ${label} prompts, replies, plans and tool input`, async () => {
      const events = await PARSERS['claude-code'].parse({
        sessionId: SESSION,
        now: NOW,
        lines: linesOf([
          { type: 'user', promptId: 'first', message: { content: oversized }, timestamp: TIME },
          { type: 'assistant', message: { content: [
            { type: 'text', text: `<ultraplan>\n# Large plan\n${oversized}\n</ultraplan>` },
            { type: 'tool_use', id: 'large-tool', name: 'Read', input: { content: oversized } },
          ] }, timestamp: TIME },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'large-tool', content: 'ok' }] }, timestamp: TIME },
          { type: 'user', promptId: 'later', message: { content: 'later valid prompt' }, timestamp: TIME },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'later valid reply' }] }, timestamp: TIME },
        ]),
      });
      expectAdmitted(events);
      expect(events.some((event) => event.kind === 'prompt' && event.payload.text === 'later valid prompt')).toBe(true);
      expect(events.some((event) => event.kind === 'response' && event.payload.text === 'later valid reply')).toBe(true);
      expect(events.find((event) => event.kind === 'plan')?.payload.content).toContain('not kept');
      expect(events.find((event) => event.kind === 'tool.use')?.payload.input).toEqual({ omitted: 'transcript tool input exceeds ingest bounds' });
    });
  }

  for (const agent of ['cline', 'opencode'] as const) {
    it(`bounds plugin transcript events for ${agent} and keeps the next turn`, async () => {
      const huge = '🌱\\"'.repeat(100_000);
      const events = await PARSERS[agent].parse({ sessionId: SESSION, now: NOW, lines: linesOf([
        { v: 1, type: 'prompt', promptId: SESSION, text: huge, at: TIME },
        { v: 1, type: 'tool', name: 'read', input: { nested: { content: huge } }, failed: false, at: TIME },
        { v: 1, type: 'response', text: huge, at: TIME },
        { v: 1, type: 'prompt', promptId: SESSION, text: 'later valid prompt', at: TIME },
        { v: 1, type: 'response', text: 'later valid reply', at: TIME },
      ]) });
      expectAdmitted(events);
      expect(events.some((event) => event.kind === 'response' && event.payload.text === 'later valid reply')).toBe(true);
    });
  }

  it('bounds Codex prompt, plan, reply and tool input before its later turn', async () => {
    const huge = '\\"🌱'.repeat(100_000);
    const message = (role: string, text: string) => ({ type: 'response_item', timestamp: TIME, payload: {
      type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    } });
    const events = await PARSERS.codex.parse({ sessionId: SESSION, now: NOW, lines: linesOf([
      message('user', huge),
      { type: 'response_item', timestamp: TIME, payload: { type: 'function_call', call_id: 'large', name: 'shell', arguments: JSON.stringify({ content: huge }) } },
      { type: 'response_item', timestamp: TIME, payload: { type: 'function_call_output', call_id: 'large', output: 'ok' } },
      message('assistant', `<ultraplan>\n# Large plan\n${huge}\n</ultraplan>`),
      message('user', 'later valid prompt'),
      message('assistant', 'later valid reply'),
    ]) });
    expectAdmitted(events);
    expect(events.some((event) => event.kind === 'response' && event.payload.text === 'later valid reply')).toBe(true);
  });

  it('bounds Cursor prompt and reply before its later turn', async () => {
    const huge = '\n🌱"'.repeat(100_000);
    const record = (role: string, text: string) => ({ role, message: { content: [{ type: 'text', text }] }, timestamp: TIME });
    const events = await PARSERS.cursor.parse({ sessionId: SESSION, now: NOW, lines: linesOf([
      record('user', `<user_query>\n${huge}\n</user_query>`),
      record('assistant', huge),
      { type: 'turn_ended' },
      record('user', '<user_query>later valid prompt</user_query>'),
      record('assistant', 'later valid reply'),
      { type: 'turn_ended' },
    ]) });
    expectAdmitted(events);
    expect(events.some((event) => event.kind === 'response' && event.payload.text === 'later valid reply')).toBe(true);
  });

  it('bounds Pi prompt, plan, reply and tool input before its later turn', async () => {
    const huge = '\\"🌱'.repeat(100_000);
    const message = (role: string, content: unknown[]) => ({ type: 'message', timestamp: TIME, message: { role, content } });
    const events = await PARSERS.pi.parse({ sessionId: SESSION, now: NOW, lines: linesOf([
      message('user', [{ type: 'text', text: huge }]),
      message('assistant', [{ type: 'text', text: `<ultraplan>\n# Large plan\n${huge}\n</ultraplan>` }, { type: 'toolCall', id: 'large', name: 'bash', arguments: { content: huge } }]),
      message('toolResult', [{ type: 'text', text: 'ok' }]),
      message('user', [{ type: 'text', text: 'later valid prompt' }]),
      message('assistant', [{ type: 'text', text: 'later valid reply' }]),
    ]) });
    expectAdmitted(events);
    expect(events.some((event) => event.kind === 'response' && event.payload.text === 'later valid reply')).toBe(true);
  });

  it('bounds a pending tool input in the persisted parser continuation', async () => {
    const state = {};
    const events = await PARSERS['claude-code'].parse({ sessionId: SESSION, now: NOW, state, lines: linesOf([
      { type: 'user', promptId: 'first', message: { content: 'first prompt' }, timestamp: TIME },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'large-tool', name: 'Read', input: { content: '🌱'.repeat(200_000) } }] }, timestamp: TIME },
    ]) });
    expectAdmitted(events);
    expect((state as { pending: Record<string, { input: unknown }> }).pending['large-tool'].input).toEqual({ omitted: 'transcript tool input exceeds ingest bounds' });
  });

  it('omits a deep tool input that the envelope inspection would refuse', async () => {
    let input: unknown = { leaf: 'ok' };
    for (let depth = 0; depth < 40; depth += 1) input = { nested: input };
    const events = await PARSERS.cline.parse({ sessionId: SESSION, now: NOW, lines: linesOf([
      { v: 1, type: 'prompt', promptId: SESSION, text: 'first prompt', at: TIME },
      { v: 1, type: 'tool', name: 'read', input, failed: false, at: TIME },
      { v: 1, type: 'prompt', promptId: SESSION, text: 'later valid prompt', at: TIME },
    ]) });
    expectAdmitted(events);
    expect(events.find((event) => event.kind === 'tool.use')?.payload.input).toEqual({ omitted: 'transcript tool input exceeds ingest bounds' });
  });
});
