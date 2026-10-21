import { describe, expect, it } from 'bun:test';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { READ_BEFORE_PIN } from '@myco-server-worker/ingest/prompt-scheme.js';
import { DECLARED_RECORD_SCHEMES } from '@myco-server-worker/ingest/record-scheme.js';
import { LEGACY_RECORD_ID_SCHEME } from '@goondocks/myco-shared/record-identity';
import type { DerivedEvent, ParsedLine, ParserState } from '@myco-server-worker/ingest/parsers/index.js';
import { canonicalPromptId, type TurnSubmission } from '@goondocks/myco-shared/prompt-identity';
import { uuidv5 } from '@myco-server-worker/hash.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
import { continuityRecords as records } from './helpers/continuity-records.js';

function linesOf(values: Record<string, unknown>[]): ParsedLine[] {
  let offset = 0;
  return values.map((value, n) => {
    const line = { value: { ...value, timestamp: new Date(NOW - 10000 + n).toISOString() }, offset };
    offset += new TextEncoder().encode(JSON.stringify(line.value)).length + 1;
    return line;
  });
}

function afterCheckpoint(events: DerivedEvent[], state: ParserState): DerivedEvent[] {
  const unknown = new Set(state.reply?.parts.filter(part => part.source === undefined).map(part => part.offset));
  return events.map(event => event.kind === 'response' && unknown.has(event.offset) ? { ...event, source: undefined } : event);
}

describe('incremental parser continuation', () => {
  for (const agent of ['opencode', 'cline']) {
    for (const [pin, recordScheme] of [['legacy', LEGACY_RECORD_ID_SCHEME], ['current', DECLARED_RECORD_SCHEMES[agent]!]] as const) {
      it(`${agent}: the registered wrapper extracts response and tool sources under the ${pin} pin`, async () => {
        const events = await PARSERS[agent]!.parse({
          transcriptId: 'tx_plugin_pinned', recordScheme, scheme: READ_BEFORE_PIN[agent]!,
          sessionId: 'plugin-pinned', now: NOW, lines: linesOf(records[agent]!),
        });
        const replies = events.filter(event => event.kind === 'response');
        expect(replies).toHaveLength(1);
        expect(replies[0]!.payload.text).toBe('first\n\nsecond');
        const tools = events.filter(event => event.kind === 'tool.use');
        expect(tools).toHaveLength(1);
        expect(tools[0]!.payload).toMatchObject({ toolName: 'Read', output: 'ok', success: true });
        for (const event of [...replies, ...tools]) {
          expect(event.source).toEqual({ position: true, block: 0 });
          expect(event.legacyId).toBeString();
          expect(event.payload).not.toHaveProperty('source');
          const id = event.kind === 'response' ? event.payload.responseId : event.payload.toolCallId;
          expect(id).toBeString();
          if (pin === 'legacy') expect(id).toBe(event.legacyId);
          else expect(id).not.toBe(event.legacyId);
        }
      });
    }
  }

  for (const agent of ['claude-code', 'codex', 'pi']) {
    it(`${agent}: a terminal read records unanswered calls and a late result retains their identity`, async () => {
      const parser = PARSERS[agent];
      const lines = linesOf(records[agent]);
      const callIndex = agent === 'codex' ? 2 : 1;
      const state = {};
      const before = await parser.parse({ transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, lines: lines.slice(0, callIndex + 1), sessionId: 's1', scheme: READ_BEFORE_PIN[agent]!, now: NOW, state });
      expect(before.filter((event) => event.kind === 'tool.failure')).toEqual([]);
      const terminalInput = { transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, lines: [], sessionId: 's1', scheme: READ_BEFORE_PIN[agent]!, now: NOW, state, terminal: 'session_end' as const };
      const terminal = await parser.parse(terminalInput);
      const failure = terminal.find((event) => event.kind === 'tool.failure');
      expect(failure?.payload).toMatchObject({ success: false, resultReason: 'no_result:session_end' });
      expect(Object.keys(JSON.parse(JSON.stringify(state)).pending ?? {})).toEqual([]);
      const later = await parser.parse({ transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, lines: [lines[callIndex + 1]], sessionId: 's1', scheme: READ_BEFORE_PIN[agent]!, now: NOW, state });
      expect(later.find((event) => event.kind === 'tool.use')?.payload).toMatchObject({ toolCallId: failure?.payload.toolCallId, success: true, output: 'ok' });
    });
  }

  it('the pending-call limit records evicted calls and bounds serialized state on every pass', async () => {
    let state = {};
    const failures: DerivedEvent[] = [];
    for (let index = 0; index < 64; index += 1) {
      const line = { value: { type: 'assistant', message: { content: [{ type: 'tool_use', id: `call-${index}`, name: 'Read', input: { index } }] } }, offset: index * 100 };
      failures.push(...(await PARSERS['claude-code'].parse({ transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, scheme: 'claude-v1',  lines: [line], sessionId: 's1', now: NOW, state })).filter((event) => event.kind === 'tool.failure'));
      state = JSON.parse(JSON.stringify(state));
      expect(Object.keys(JSON.parse(JSON.stringify(state)).pending ?? {}).length).toBeLessThanOrEqual(32);
    }
    expect(failures).toHaveLength(32);
    expect(failures.every((event) => event.payload.resultReason === 'pending_limit')).toBe(true);
  });

  for (const [agent, values] of Object.entries(records)) {
    it(`${agent}: replies retain the joined per-turn shape and the first assistant identity`, async () => {
      const parser = PARSERS[agent];
      const lines = linesOf(values);
      const events = await parser.parse({ transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, lines, sessionId: 's1', scheme: READ_BEFORE_PIN[agent]!, now: NOW });
      const replies = events.filter((event) => event.kind === 'response');
      expect(replies).toHaveLength(1);
      const texts = agent === 'claude-code' ? ['<ultraplan># First</ultraplan>', '<ultraplan># Second</ultraplan>']
        : agent === 'codex' ? ['<proposed_plan># First</proposed_plan>', '<proposed_plan># Second</proposed_plan>'] : ['first', 'second'];
      expect(replies[0].payload.text).toBe(texts.join('\n\n'));
      expect(replies[0].offset).toBe(lines[1].offset);
    });
  }

  for (const [agent, values] of Object.entries(records)) {
    for (const recordScheme of [LEGACY_RECORD_ID_SCHEME, DECLARED_RECORD_SCHEMES[agent]!]) {
      it(`${agent} ${recordScheme}: whole and every split retain full payloads and identities through serialized restart`, async () => {
        const parser = PARSERS[agent];
        const lines = linesOf(values);
        const wholeInput = { transcriptId: 'tx_legacy_fixture', recordScheme, lines, sessionId: 's1', scheme: READ_BEFORE_PIN[agent]!, now: NOW, state: {} };
        const whole = await parser.parse({ transcriptId: 'tx_legacy_fixture', recordScheme, lines, sessionId: wholeInput.sessionId, scheme: wholeInput.scheme, now: wholeInput.now });
        const ordered = (events: DerivedEvent[]) => events.toSorted((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
        for (let cut = 1; cut < lines.length; cut += 1) {
          const firstInput = { ...wholeInput, lines: lines.slice(0, cut), state: {} };
          const first = await parser.parse(firstInput);
          const prompt = first.findLast((e) => e.kind === 'prompt')?.payload.promptId;
          const secondInput = { ...wholeInput, lines: lines.slice(cut), state: JSON.parse(JSON.stringify(firstInput.state)),
            openPromptId: typeof prompt === 'string' ? prompt : undefined };
          const second = await parser.parse(secondInput);
          expect({ agent, cut, events: ordered([...first, ...second]) }).toEqual({ agent, cut, events: ordered(afterCheckpoint(whole, firstInput.state)) });
        }
        if (agent !== 'cursor') expect(whole.filter((e) => e.kind.startsWith('tool.')).map((e) => [e.kind, e.payload.success, e.payload.output])).toEqual([['tool.use', true, 'ok']]);
        if (parser.planTags.length > 0) expect(new Set(whole.filter((e) => e.kind === 'plan').map((e) => e.payload.planKey)).size).toBe(2);
      });
    }
  }

  it('codex under its turn key: whole and every split name each prompt by its turn, its opener and its acceptance order alike', async () => {
    const parser = PARSERS.codex;
    const user = (text: string, order?: number) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      ...(order === undefined ? {} : { metadata: { user_input_order: order } }) });
    const reply = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
    const lines = linesOf([
      { type: 'session_meta', payload: { source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      user('<environment_context>cwd: /repo</environment_context>'), user('open', 0), reply('first'), user('steer', 2), reply('second'),
      { type: 'turn_context', payload: { turn_id: 'turn-2' } },
      user('next', 4), reply('third'),
    ]);
    const input = { transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, sessionId: 's1', scheme: 'codex-turn-v1' as const, now: NOW };
    const whole = await parser.parse({ ...input, lines, state: {} });
    const named = (turnId: string, submission: TurnSubmission) => canonicalPromptId(uuidv5, { scheme: 'codex-turn-v1', sessionId: 's1', turnId, submission });
    expect(whole.filter((e) => e.kind === 'prompt').map((e) => [e.payload.text, e.payload.promptId])).toEqual([
      ['<environment_context>cwd: /repo</environment_context>', await named('turn-1', { offset: lines[3]!.offset })],
      ['open', await named('turn-1', { opener: true })], ['steer', await named('turn-1', { order: 2 })], ['next', await named('turn-2', { opener: true })],
    ]);
    const ordered = (events: DerivedEvent[]) => events.toSorted((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
    for (let cut = 1; cut < lines.length; cut += 1) {
      const first = { ...input, lines: lines.slice(0, cut), state: {} };
      const before = await parser.parse(first);
      const prompt = before.findLast((e) => e.kind === 'prompt' && e.opensTurn !== false)?.payload.promptId;
      const after = await parser.parse({ ...input, lines: lines.slice(cut), state: JSON.parse(JSON.stringify(first.state)),
        openPromptId: typeof prompt === 'string' ? prompt : undefined });
      expect({ cut, events: ordered([...before, ...after]) }).toEqual({ cut, events: ordered(afterCheckpoint(whole, first.state)) });
    }
  });

  it('codex under its turn key: a message outside any turn the window has read names no prompt', async () => {
    const lines = linesOf([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mid-turn' }] }, metadata: { user_input_order: 3 } }]);
    expect((await PARSERS.codex.parse({ transcriptId: 'tx_legacy_fixture', recordScheme: 'legacy-session-v1' as const, sessionId: 's1', scheme: 'codex-turn-v1', now: NOW, lines, state: {} })).filter((e) => e.kind === 'prompt')).toEqual([]);
  });
});
