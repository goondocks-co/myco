/**
 * The per-agent transcript parsers.
 *
 * Every assertion that ranges over agents enumerates `PARSERS`, so a parser
 * added without a fixture, or declaring a fidelity outside the closed set, or
 * emitting a kind the catalogue does not hold, fails BY NAME rather than by a
 * count that would pass for the wrong reason.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PARSERS, parserFor } from '@myco-server-worker/ingest/parsers/registry.js';
import { FIDELITIES, REPLY_SEPARATOR, replyChunks, responseBound, truncationMarker, type DerivedEvent, type ParsedLine } from '@myco-server-worker/ingest/parsers/index.js';
import { MAX_ID_CHARS, MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import { utf8 } from '@myco-server-worker/hash.js';
import { kindSpec, parsePayload } from '@myco-server-worker/ingest/kinds.js';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { promptTextOf, responseTextOf } from '@myco-server-worker/ingest/parsers/cursor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

/** One named fixture per registered parser; a parser with no entry fails the coverage gate below. */
const FIXTURE_FOR: Record<string, string> = {
  'claude-code': 'claude-parse-basic.jsonl',
  cline: 'cline-parse-basic.jsonl',
  codex: 'codex-parse-basic.jsonl',
  cursor: 'cursor-parse-basic.jsonl',
  opencode: 'opencode-parse-basic.jsonl',
  pi: 'pi-parse-basic.jsonl',
};

const SESSION = 's1';
/** A server clock every fixture's line times sit behind, so none is clamped. */
const NOW = Date.parse('2027-01-01T00:00:00Z');

/** Fixture bytes split into lines carrying their real byte offsets, exactly as the parse driver hands them over. */
function linesOf(file: string): ParsedLine[] {
  return linesOfText(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
}

/** Transcript text split into lines carrying their real byte offsets. */
function linesOfText(raw: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let offset = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() !== '') {
      try {
        const value: unknown = JSON.parse(line);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push({ value: value as Record<string, unknown>, offset });
      } catch { /* a partial line is the next pass's */ }
    }
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  return out;
}

const parseFixture = (agent: string): Promise<DerivedEvent[]> =>
  PARSERS[agent].parse({ lines: linesOf(FIXTURE_FOR[agent]), sessionId: SESSION, now: NOW });

const kinds = (events: DerivedEvent[]): string[] => events.map((e) => e.kind);
const only = (events: DerivedEvent[], kind: string): DerivedEvent[] => events.filter((e) => e.kind === kind);

describe('parser registry', () => {
  /**
   * What each fixture must yield, counted from the records it holds.
   *
   * Without a floor the registry-wide tests below pass vacuously on an empty
   * result: they iterate derived events, and a parser that derives none
   * satisfies every one of them. A parser reading the wrong record shape
   * therefore ships green and captures nothing.
   */
  const FLOOR: Record<string, Record<string, number>> = {
    'claude-code': { prompt: 2, response: 2, 'tool.use': 1, 'tool.failure': 1, plan: 1 },
    cline: { prompt: 1, response: 1, 'tool.use': 1, 'tool.failure': 1 },
    codex: { prompt: 1, response: 1, 'tool.use': 1 },
    cursor: { prompt: 2, response: 2 },
    opencode: { prompt: 1, response: 1, 'tool.use': 1, 'tool.failure': 1 },
    pi: { prompt: 1, response: 1, 'tool.use': 1 },
  };


  it('derives at least one event for every agent that declares a parser', async () => {
    // The floor under every test below: an agent whose parser reads a shape its
    // transcripts do not carry derives nothing, and nothing else here notices.
    for (const agent of Object.keys(PARSERS)) {
      expect({ agent, derived: (await parseFixture(agent)).length > 0 }).toEqual({ agent, derived: true });
    }
  });

  it('derives the kinds its fixture holds, in the counts the fixture holds them', async () => {
    for (const agent of Object.keys(PARSERS)) {
      const floor = FLOOR[agent];
      expect({ agent, declared: floor !== undefined }).toEqual({ agent, declared: true });
      const derived = kinds(await parseFixture(agent));
      // Every kind derived is counted, not only the declared ones: a parser
      // that started emitting a kind the fixture cannot justify fails here too.
      const counted: Record<string, number> = {};
      for (const kind of derived) counted[kind] = (counted[kind] ?? 0) + 1;
      expect({ agent, counted }).toEqual({ agent, counted: floor });
    }
  });

  it('gives every registered parser a named fixture, so a parser cannot ship unproven', () => {
    expect(Object.keys(PARSERS).filter((agent) => FIXTURE_FOR[agent] === undefined)).toEqual([]);
    for (const file of Object.values(FIXTURE_FOR)) expect({ file, exists: fs.existsSync(path.join(FIXTURES, file)) }).toEqual({ file, exists: true });
  });

  it('declares one closed fidelity per parser', () => {
    for (const [agent, parser] of Object.entries(PARSERS)) {
      expect({ agent, fidelity: parser.fidelity, known: FIDELITIES.includes(parser.fidelity) }).toEqual({ agent, fidelity: parser.fidelity, known: true });
    }
  });

  it('keys every parser under the agent it names', () => {
    for (const [agent, parser] of Object.entries(PARSERS)) expect(parser.agent).toBe(agent);
  });

  it('answers null for an agent the server reads no transcript for', () => {
    expect(parserFor('windsurf')).toBeNull();
    expect(parserFor(null)).toBeNull();
  });

  it('emits only payloads the closed kind catalogue admits', async () => {
    for (const agent of Object.keys(PARSERS)) {
      for (const event of await parseFixture(agent)) {
        const spec = kindSpec(event.kind);
        expect({ agent, kind: event.kind, known: spec !== null }).toEqual({ agent, kind: event.kind, known: true });
        const parsed = parsePayload(spec!, event.payload, NOW);
        expect({ agent, kind: event.kind, ok: parsed.ok, reason: parsed.ok ? null : parsed.reason }).toEqual({ agent, kind: event.kind, ok: true, reason: null });
      }
    }
  });

  it('dates every event at or before the server clock and names the byte that produced it', async () => {
    for (const agent of Object.keys(PARSERS)) {
      for (const event of await parseFixture(agent)) {
        expect(event.createdAt).toBeLessThanOrEqual(NOW);
        expect(event.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is a pure function of its input: parsing twice yields identical events', async () => {
    for (const agent of Object.keys(PARSERS)) {
      expect(await parseFixture(agent)).toEqual(await parseFixture(agent));
    }
  });
});

describe('claude-code parser', () => {
  it('derives prompts, one response per turn, tool calls and a plan', async () => {
    const events = await parseFixture('claude-code');
    // Each joined reply is dated to the first assistant record of its turn.
    expect(kinds(events)).toEqual(['prompt', 'plan', 'response', 'tool.use', 'tool.failure', 'prompt', 'response']);
  });

  it('skips a meta record and never turns a tool result into a prompt', async () => {
    const prompts = only(await parseFixture('claude-code'), 'prompt');
    expect(prompts.map((p) => p.payload.text)).toEqual(['add a retention window', 'and run the tests']);
  });

  it('derives a prompt id the member derives too, so one prompt is one row on either path', async () => {
    const prompts = only(await parseFixture('claude-code'), 'prompt');
    // The member scopes a dedupe identity by the shape that matched it, so the
    // parse must too or the two paths write one prompt as two rows.
    expect(prompts[0].payload.promptId).toBe(await uuidv5('queued-prompt', SESSION, 'user_prompt|11111111-1111-4111-8111-111111111111'));
    expect(prompts[1].payload.promptId).toBe(await uuidv5('queued-prompt', SESSION, 'queued_command|22222222-2222-4222-8222-222222222222'));
  });

  it('pairs a tool call with the result that names it, keeping input and output on one row', async () => {
    const [call] = only(await parseFixture('claude-code'), 'tool.use');
    expect(call.payload.toolName).toBe('Read');
    expect(call.payload.input).toEqual({ file_path: '/repo/x.ts' });
    expect(call.payload.output).toBe('export const x = 1');
    expect(call.payload.success).toBe(true);
  });

  it('records an errored result as a failure carrying its message', async () => {
    const [failure] = only(await parseFixture('claude-code'), 'tool.failure');
    expect(failure.payload.toolName).toBe('Bash');
    expect(failure.payload.success).toBe(false);
    expect(failure.payload.errorMessage).toBe('exit 1');
  });

  it('attributes a tool call and a response to the prompt whose turn they fall in', async () => {
    const events = await parseFixture('claude-code');
    const first = only(events, 'prompt')[0].payload.promptId;
    expect(only(events, 'tool.use')[0].payload.promptId).toBe(first);
    expect(only(events, 'response')[0].payload.promptId).toBe(first);
    expect(only(events, 'response')[1].payload.promptId).toBe(only(events, 'prompt')[1].payload.promptId);
  });

  it('lifts a plan out of its tag envelope with the member key, a title and its channel', async () => {
    const [plan] = only(await parseFixture('claude-code'), 'plan');
    expect(plan.payload.planKey).toBe(await uuidv5('plan-tag', SESSION, 'ultraplan', '0'));
    expect(plan.payload.title).toBe('Retention');
    expect(plan.payload.content).toBe('# Retention\n- [ ] add the leaf\n- [x] measure');
    expect(plan.payload.source).toBe('tag');
    expect(plan.payload.originPath).toBe('transcript:ultraplan');
    expect(plan.payload.tags).toEqual(['ultraplan']);
  });

  it('joins assistant records across a tool result and names the reply by its first assistant byte', async () => {
    const responses = only(await parseFixture('claude-code'), 'response');
    expect(responses).toHaveLength(2);
    expect(responses[0].payload.text).toBe('Looking now.\n\n<ultraplan>\n# Retention\n- [ ] add the leaf\n- [x] measure\n</ultraplan>\n\nDone.');
    expect(responses[1].payload.text).toBe('Tests pass.');
    const assistantOffsets = linesOf('claude-parse-basic.jsonl').filter(({ value }) => value.type === 'assistant').map(({ offset }) => offset);
    expect(responses.map(({ offset }) => offset)).toEqual([assistantOffsets[0], assistantOffsets[2]]);
    expect(responses.map(({ payload }) => payload.responseId)).toEqual(await Promise.all([assistantOffsets[0], assistantOffsets[2]].map((offset) => uuidv5('response', SESSION, String(offset)))));
    expect(responses.map(({ createdAt }) => createdAt)).toEqual([Date.parse('2026-09-01T10:00:02Z'), Date.parse('2026-09-01T10:00:07Z')]);
  });

  it('records a call the transcript never answered rather than dropping it', async () => {
    const lines = linesOf('claude-parse-basic.jsonl').filter((l) => l.value.uuid !== 'r1');
    const events = await PARSERS['claude-code'].parse({ lines, sessionId: SESSION, now: NOW });
    const unfinished = only(events, 'tool.failure').find((e) => e.payload.toolName === 'Read');
    expect(unfinished?.payload.errorMessage).toBe('tool call has no result in the transcript');
  });

  it('gives every tool call of one assistant message its own row identity', async () => {
    const events = await PARSERS['claude-code'].parse({ lines: linesOf('claude-parse-parallel.jsonl'), sessionId: SESSION, now: NOW });
    const calls = only(events, 'tool.use');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.payload.toolCallId)).toEqual([
      await uuidv5('tool-call', SESSION, 'toolu_a'),
      await uuidv5('tool-call', SESSION, 'toolu_b'),
    ]);
    // They share the line that produced them, which is why the byte offset
    // cannot name them apart.
    expect(new Set(calls.map((c) => c.offset)).size).toBe(1);
  });

  it('gives every plan envelope of one text block its own key', async () => {
    const plans = only(await PARSERS['claude-code'].parse({ lines: linesOf('claude-parse-parallel.jsonl'), sessionId: SESSION, now: NOW }), 'plan');
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.payload.title)).toEqual(['First', 'Second']);
    expect(new Set(plans.map((p) => p.payload.planKey)).size).toBe(2);
    expect(new Set(plans.map((p) => p.offset)).size).toBe(1);
  });

  it('parses a subagent sibling as an ordinary transcript of the same session', async () => {
    const events = await PARSERS['claude-code'].parse({ lines: linesOf('claude-parse-subagent.jsonl'), sessionId: SESSION, now: NOW });
    expect(kinds(events)).toEqual(['prompt', 'response', 'tool.use']);
    expect(only(events, 'tool.use')[0].payload.toolName).toBe('Grep');
  });
});

describe('codex parser', () => {
  it('keeps only the human turn and assistant reply from the recorded interactive context', async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, 'codex-context-redacted.jsonl'));
    const provenance = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-context-provenance.json'), 'utf8')) as { redacted_sha256: string; retained_message_rows: number };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.redacted_sha256);
    const lines = linesOf('codex-context-redacted.jsonl');
    expect(lines).toHaveLength(provenance.retained_message_rows + 1);
    const events = await PARSERS.codex.parse({ lines, sessionId: SESSION, now: NOW });
    expect(events.map(({ kind, payload }) => [kind, payload.text, payload.origin])).toEqual([
      ['prompt', '[redacted text]', 'user'], ['response', '[redacted text]', undefined],
    ]);
  });

  it('does not project developer messages as responses in the native rollout', async () => {
    const lines = linesOf('codex-0.153.4-redacted.jsonl');
    const events = await PARSERS.codex.parse({ lines, sessionId: SESSION, now: NOW });
    expect(only(events, 'response')).toHaveLength(1);
    const assistantOffsets = lines.filter(({ value }) => {
      const payload = value.payload as { role?: string };
      return payload.role === 'assistant';
    }).map(({ offset }) => offset);
    expect(only(events, 'response').map(({ offset }) => offset)).toEqual(assistantOffsets.slice(0, 1));
    expect(only(events, 'response')[0].payload.text).toBe('[redacted text]\n\n[redacted text]');
  });

  it('applies declared Codex prompt drops, origins and desktop rewriting', async () => {
    const messages = [
      '# AGENTS.md instructions for /repo\nProject rules',
      '<recommended_plugins>\n# AGENTS.md instructions for /repo\nProject rules\n</recommended_plugins>',
      '<environment_context>cwd: /repo</environment_context>',
      '<subagent_notification>done</subagent_notification>',
      '<skills_instructions>Use project skills</skills_instructions>',
      'Editor context\n## My request for Codex:\nFix capture\n',
    ];
    const lines = messages.map((text, offset) => ({ offset, value: { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } } }));
    const events = await PARSERS.codex.parse({ lines, sessionId: SESSION, now: NOW, transcriptMeta: { source: 'cli' } });
    expect(only(events, 'prompt').map(({ payload }) => [payload.text, payload.origin])).toEqual([
      [messages[2], 'system'], [messages[3], 'agent_dispatch'], [messages[4], 'system'], ['Fix capture', 'user'],
    ]);
  });

  it('pins the redacted recording and the item variants its provenance declares', () => {
    const file = 'codex-0.153.4-redacted.jsonl';
    const provenance = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-0.153.4-provenance.json'), 'utf8')) as {
      redacted_sha256: string; retained_rows: number; types: string[];
    };
    const lines = linesOf(file);
    expect(createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, file))).digest('hex')).toBe(provenance.redacted_sha256);
    expect(lines).toHaveLength(provenance.retained_rows);
    expect([...new Set(lines.map(({ value }) => (value.payload as { type: string }).type))].sort()).toEqual(provenance.types);
  });

  it('derives a prompt, a tool call and a response, skipping meta and reasoning records', async () => {
    const events = await parseFixture('codex');
    expect(kinds(events)).toEqual(['prompt', 'tool.use', 'response']);
  });

  it('decodes a function call\'s JSON-string arguments into the input object', async () => {
    const [call] = only(await parseFixture('codex'), 'tool.use');
    expect(call.payload.toolName).toBe('shell');
    expect(call.payload.input).toEqual({ command: 'ls' });
    expect(call.payload.output).toBe('events.ts\nkinds.ts');
  });

  it('reads user text from input_text and assistant text from output_text', async () => {
    const events = await parseFixture('codex');
    expect(only(events, 'prompt')[0].payload.text).toBe('summarise the ingest path');
    expect(only(events, 'response')[0].payload.text).toBe('Two modules carry it.');
  });
});

describe('cursor parser', () => {
  it('keeps what the person typed: every <user_query> in a line, and tag-like text in a line without one', () => {
    expect(promptTextOf('<timestamp>t</timestamp>\n<user_query>\none\n</user_query>\n<user_query>\ntwo\n</user_query>')).toBe('one\n\ntwo');
    expect(promptTextOf('please look at <b>this</b> code')).toBe('please look at <b>this</b> code');
    expect(promptTextOf('explain the <user_info>x</user_info> block')).toBe('explain the <user_info>x</user_info> block');
    expect(promptTextOf('why is the daemon restarting')).toBe('why is the daemon restarting');
  });

  it('reads a line that is only blocks the agent injected as no prompt at all', () => {
    expect(promptTextOf('<git_status>\nclean\n</git_status>')).toBe('');
    expect(promptTextOf('<available_subagent_types>\nx\n</available_subagent_types>\n<timestamp>t</timestamp>')).toBe('');
  });

  it('drops a [REDACTED] mask wherever it stands in a reply', () => {
    expect(responseTextOf('I will [REDACTED] check.\n[REDACTED] more')).toBe('I will check.\nmore');
    expect(responseTextOf('Checking the service log.\n\n[REDACTED]')).toBe('Checking the service log.');
    expect(responseTextOf('[REDACTED]')).toBe('');
    expect(responseTextOf('first\n[REDACTED]\n\nsecond')).toBe('first\n\nsecond');
  });

  it('declares the fidelity its format can support and derives no tool calls', async () => {
    expect(PARSERS.cursor.fidelity).toBe('no_tool_results');
    const events = await parseFixture('cursor');
    expect(kinds(events)).toEqual(['prompt', 'response', 'prompt', 'response']);
  });

  it('reads a recorded cursor-agent transcript into its prompt and its reply (#1461)', async () => {
    const events = await PARSERS.cursor.parse({ lines: linesOf('cursor-agent-2026.09-redacted.jsonl'), sessionId: SESSION, now: NOW });
    expect(only(events, 'prompt').map((e) => e.payload.text)).toEqual([
      'List the files in this directory and say how many there are. Do not modify anything.',
    ]);
    const responses = only(events, 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0].payload.promptId).toBe(only(events, 'prompt')[0].payload.promptId);
    expect(responses[0].payload.text).toStartWith('Listing the directory contents without changing anything.\n\nTrying a simpler listing approach:');
    expect(responses[0].payload.text).toEndWith('7. `AGENTS.md`\n\nNothing was modified.');
    const firstAssistant = linesOf('cursor-agent-2026.09-redacted.jsonl').find(({ value }) => value.role === 'assistant');
    if (firstAssistant === undefined) throw new Error('recording has no assistant reply');
    expect(responses[0].offset).toBe(firstAssistant.offset);
    expect(responses[0].payload.responseId).toBe(await uuidv5('response', SESSION, String(firstAssistant.offset)));
  });

  it('takes what the person typed out of its <user_query> wrapper, and skips a line of injected context', async () => {
    const events = await parseFixture('cursor');
    expect(only(events, 'prompt').map((e) => e.payload.text)).toEqual(['why is the daemon restarting', 'and how do I stop it']);
  });

  it('drops the [REDACTED] reasoning masks and joins each turn', async () => {
    const events = await parseFixture('cursor');
    const [first, second] = only(events, 'prompt');
    expect(only(events, 'response').map((e) => ({ promptId: e.payload.promptId, text: e.payload.text }))).toEqual([
      { promptId: first.payload.promptId, text: 'Checking the service log.\n\nThe lease expired.' },
      { promptId: second.payload.promptId, text: 'Renew the lease before it lapses.' },
    ]);
  });
});

/** A turn's reply is split at message boundaries when one response cannot hold it. */
describe('a reply longer than one response holds', () => {
  const TEXT_CHARS = (() => {
    const bound = kindSpec('response')?.fields.text.bound;
    if (bound?.type !== 'string') throw new Error('no string bound on response.text');
    return bound.max;
  })();
  /** The same two bounds the parser applies, derived here from their sources rather than from the parser. */
  const payloadFits = (payload: Record<string, unknown>) => utf8(JSON.stringify(payload)).byteLength <= MAX_PAYLOAD_BYTES;
  const fitsOne = (text: string) => text.length <= TEXT_CHARS
    && payloadFits({ responseId: 'x'.repeat(MAX_ID_CHARS), promptId: 'x'.repeat(MAX_ID_CHARS), text });

  /** Assistant messages of about `size` characters each, several of them multibyte, so both the character and the byte bound decide a split. */
  const messages = (count: number, size: number) => Array.from({ length: count }, (_, i) =>
    `message ${i} ${(i % 3 === 0 ? 'é—' : i % 3 === 1 ? '🍄"\\' : 'plain ').repeat(Math.ceil(size / 6)).slice(0, size)}`);

  const codexLines = (replies: string[]) => linesOfText([
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize everything' }] } }),
    ...replies.map((text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })),
  ].join('\n') + '\n');
  const cursorLines = (replies: string[]) => linesOfText([
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nsummarize everything\n</user_query>' }] } }),
    ...replies.map((text) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } })),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n') + '\n');

  for (const [agent, linesFor] of [['codex', codexLines], ['cursor', cursorLines]] as const) {
    it(`${agent}: splits a 600,000-character turn at message boundaries into admitted responses`, async () => {
      const replies = messages(24, 25_000);
      const lines = linesFor(replies);
      const events = await PARSERS[agent].parse({ lines, sessionId: SESSION, now: NOW });
      const responses = only(events, 'response');
      const whole = replies.join(REPLY_SEPARATOR);
      expect(whole.length).toBeGreaterThan(TEXT_CHARS);
      expect(responses.length).toBeGreaterThan(1);
      // Every response lands: the kind's bounds and the envelope's payload bound both hold.
      for (const r of responses) {
        expect(parsePayload(kindSpec('response')!, r.payload, NOW).ok).toBe(true);
        expect(payloadFits(r.payload)).toBe(true);
      }
      // Response chunks preserve the complete turn in message order.
      const texts = responses.map((r) => r.payload.text as string);
      expect(texts.join(REPLY_SEPARATOR)).toBe(whole);
      const assistantOffsets = lines.slice(1).map((l) => l.offset);
      expect(responses.every((r) => assistantOffsets.includes(r.offset))).toBe(true);
      expect(responses[0].offset).toBe(assistantOffsets[0]);
      for (let i = 0; i < responses.length - 1; i += 1) {
        const nextFirst = replies[assistantOffsets.indexOf(responses[i + 1].offset)];
        expect(fitsOne(texts[i] + REPLY_SEPARATOR + nextFirst)).toBe(false);
      }
      // Each chunk takes its first message's identity and answers the same prompt.
      for (const r of responses) expect(r.payload.responseId).toBe(await uuidv5('response', SESSION, String(r.offset)));
      expect(new Set(responses.map((r) => r.payload.promptId)).size).toBe(1);
    });

    it(`${agent}: cuts a single message too long for any response short, and says how much it left out`, async () => {
      const long = `start ${'🍄 over the bound '.repeat(40_000)}end`;
      const events = await PARSERS[agent].parse({ lines: linesFor(['before', long, 'after']), sessionId: SESSION, now: NOW });
      const texts = only(events, 'response').map((r) => r.payload.text as string);
      expect(texts.length).toBe(3);
      expect(texts[0]).toBe('before');
      expect(texts[2]).toBe('after');
      const cut = texts[1];
      expect(fitsOne(cut)).toBe(true);
      const at = cut.lastIndexOf(`${REPLY_SEPARATOR}[`);
      const kept = cut.slice(0, at);
      expect(long.startsWith(kept)).toBe(true);
      expect(cut.slice(at)).toBe(truncationMarker(long.length - kept.length));
      expect(kept.length).toBeGreaterThan(long.length / 4);
    });
  }

  it('pins each joined response identity, offset, time, prompt and text from recorded transcripts', async () => {
    const pinned: Array<[string, string, number, string]> = [
      ['codex', 'codex-parse-basic.jsonl', 1, 'c828fd50ab8880c182b5dab339a9eaf01d5f61b9b7da72759ca24e19fa5ed9bb'],
      ['codex', 'codex-context-redacted.jsonl', 1, 'a183b0c3a973b1dcc572d1740c96fe5383ccb1ccdc5843c64e7e7c7ea24936f1'],
      ['codex', 'codex-0.153.4-redacted.jsonl', 1, 'b9b5485d9a812fe5645edc297ef36b0ba7ea82bdcaf8139e86b6f6f0d4ea612c'],
      ['cursor', 'cursor-parse-basic.jsonl', 2, '693870a68ffa541359c742e715c90bd3a5a4ba8dc26c57ed86a26a5e9ad18778'],
      ['cursor', 'cursor-agent-2026.09-redacted.jsonl', 1, 'ada97dd05035b9a07a309c184c8a25ae72423f5a5c621c4a1d33fcb908dfc21f'],
    ];
    const seen = [];
    for (const [agent, file] of pinned) {
      const events = await PARSERS[agent].parse({ lines: linesOf(file), sessionId: SESSION, now: NOW });
      const rows = only(events, 'response').map((e) => [e.payload.responseId, e.offset, e.createdAt, e.payload.promptId ?? null, e.payload.text]);
      seen.push([agent, file, rows.length, createHash('sha256').update(JSON.stringify(rows)).digest('hex')]);
    }
    expect(seen).toEqual(pinned);
  });

  it('reads its bounds from the catalogue and the envelope, and the parsers name no number of their own', () => {
    expect(responseBound()).toEqual({
      chars: TEXT_CHARS,
      bytes: MAX_PAYLOAD_BYTES - utf8(JSON.stringify({ responseId: 'x'.repeat(MAX_ID_CHARS), promptId: 'x'.repeat(MAX_ID_CHARS), text: '' })).byteLength,
    });
    const dir = path.join(REPO_ROOT, 'packages', 'myco-server', 'src', 'ingest', 'parsers');
    for (const file of fs.readdirSync(dir)) expect({ file, cap: /262[_,]?144|256 \* 1024/.test(fs.readFileSync(path.join(dir, file), 'utf8')) }).toEqual({ file, cap: false });
  });

  it('returns a reply that fits as one response named by its first message', () => {
    const parts = [{ text: '  one ', offset: 10, createdAt: 1 }, { text: 'two', offset: 20, createdAt: 2 }, { text: ' three  ', offset: 30, createdAt: 3 }];
    expect(replyChunks(parts)).toEqual([{ text: 'one \n\ntwo\n\n three', offset: 10, createdAt: 1 }]);
    expect(replyChunks(parts, { chars: 12, bytes: 1000 })).toEqual([
      { text: 'one \n\ntwo', offset: 10, createdAt: 1 },
      { text: ' three', offset: 30, createdAt: 3 },
    ]);
  });
});
