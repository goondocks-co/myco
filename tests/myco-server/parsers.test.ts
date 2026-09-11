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
import { FIDELITIES, type DerivedEvent, type ParsedLine } from '@myco-server-worker/ingest/parsers/index.js';
import { kindSpec, parsePayload } from '@myco-server-worker/ingest/kinds.js';
import { uuidv5 } from '@myco-server-worker/hash.js';

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
  const raw = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
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
    cursor: { prompt: 1, response: 1 },
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
    // Offset order, ties in insertion order: everything a turn produced is
    // dated to the byte that produced it, and a turn's response is dated to
    // the first assistant byte of the turn rather than its last.
    expect(kinds(events)).toEqual(['prompt', 'plan', 'tool.use', 'response', 'tool.failure', 'prompt', 'response']);
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

  it('joins a turn\'s assistant text into one response rather than one per record', async () => {
    const responses = only(await parseFixture('claude-code'), 'response');
    // A tool result is not a turn boundary, so both assistant records of the
    // first turn join into its single response.
    expect(responses).toHaveLength(2);
    expect(responses[0].payload.text).toContain('Looking now.');
    expect(responses[0].payload.text).toContain('Done.');
    expect(responses[1].payload.text).toBe('Tests pass.');
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
    expect(kinds(events)).toEqual(['prompt', 'tool.use', 'response']);
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
  it('declares the fidelity its format can support and derives no tool calls', async () => {
    expect(PARSERS.cursor.fidelity).toBe('no_tool_results');
    const events = await parseFixture('cursor');
    expect(kinds(events)).toEqual(['prompt', 'response']);
  });

  it('reads content in both the string and the block-array form', async () => {
    const events = await parseFixture('cursor');
    expect(only(events, 'prompt')[0].payload.text).toBe('why is the daemon restarting');
    expect(only(events, 'response')[0].payload.text).toBe('The lease expired.');
  });
});
