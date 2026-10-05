import { describe, expect, it } from 'bun:test';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import type { DerivedEvent, ParsedLine } from '@myco-server-worker/ingest/parsers/index.js';

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

describe('incremental parser continuation', () => {
  for (const agent of ['claude-code', 'codex', 'pi']) {
    it(`${agent}: a terminal read records unanswered calls and a late result retains their identity`, async () => {
      const parser = PARSERS[agent];
      const lines = linesOf(records[agent]);
      const callIndex = agent === 'codex' ? 2 : 1;
      const state = {};
      const before = await parser.parse({ lines: lines.slice(0, callIndex + 1), sessionId: 's1', now: NOW, state });
      expect(before.filter((event) => event.kind === 'tool.failure')).toEqual([]);
      const terminalInput = { lines: [], sessionId: 's1', now: NOW, state, terminal: 'session_end' as const };
      const terminal = await parser.parse(terminalInput);
      const failure = terminal.find((event) => event.kind === 'tool.failure');
      expect(failure?.payload.success).toBe(false);
      expect(Object.keys(JSON.parse(JSON.stringify(state)).pending ?? {})).toEqual([]);
      const later = await parser.parse({ lines: [lines[callIndex + 1]], sessionId: 's1', now: NOW, state });
      expect(later.find((event) => event.kind === 'tool.use')?.payload).toMatchObject({ toolCallId: failure?.payload.toolCallId, success: true, output: 'ok' });
    });
  }

  it('the pending-call limit records evicted calls and bounds serialized state on every pass', async () => {
    let state = {};
    const failures: DerivedEvent[] = [];
    for (let index = 0; index < 64; index += 1) {
      const line = { value: { type: 'assistant', message: { content: [{ type: 'tool_use', id: `call-${index}`, name: 'Read', input: { index } }] } }, offset: index * 100 };
      failures.push(...(await PARSERS['claude-code'].parse({ lines: [line], sessionId: 's1', now: NOW, state })).filter((event) => event.kind === 'tool.failure'));
      state = JSON.parse(JSON.stringify(state));
      expect(Object.keys(JSON.parse(JSON.stringify(state)).pending ?? {}).length).toBeLessThanOrEqual(32);
    }
    expect(failures).toHaveLength(32);
    expect(failures.every((event) => event.payload.errorMessage === 'tool call exceeded the pending-call limit')).toBe(true);
  });

  for (const [agent, values] of Object.entries(records)) {
    it(`${agent}: replies retain the joined per-turn shape and the first assistant identity`, async () => {
      const parser = PARSERS[agent];
      const lines = linesOf(values);
      const events = await parser.parse({ lines, sessionId: 's1', now: NOW });
      const replies = events.filter((event) => event.kind === 'response');
      expect(replies).toHaveLength(1);
      const texts = agent === 'claude-code' ? ['<ultraplan># First</ultraplan>', '<ultraplan># Second</ultraplan>']
        : agent === 'codex' ? ['<proposed_plan># First</proposed_plan>', '<proposed_plan># Second</proposed_plan>'] : ['first', 'second'];
      expect(replies[0].payload.text).toBe(texts.join('\n\n'));
      expect(replies[0].offset).toBe(lines[1].offset);
    });
  }

  for (const [agent, values] of Object.entries(records)) {
    it(`${agent}: whole and every split retain full payloads and identities through serialized restart`, async () => {
      const parser = PARSERS[agent];
      const lines = linesOf(values);
      const wholeInput = { lines, sessionId: 's1', now: NOW, state: {} };
      const whole = await parser.parse({ lines, sessionId: wholeInput.sessionId, now: wholeInput.now });
      const ordered = (events: DerivedEvent[]) => events.toSorted((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
      for (let cut = 1; cut < lines.length; cut += 1) {
        const firstInput = { ...wholeInput, lines: lines.slice(0, cut), state: {} };
        const first = await parser.parse(firstInput);
        const prompt = first.findLast((e) => e.kind === 'prompt')?.payload.promptId;
        const secondInput = { ...wholeInput, lines: lines.slice(cut), state: JSON.parse(JSON.stringify(firstInput.state)),
          openPromptId: typeof prompt === 'string' ? prompt : undefined };
        const second = await parser.parse(secondInput);
        expect({ agent, cut, events: ordered([...first, ...second]) }).toEqual({ agent, cut, events: ordered(whole) });
      }
      if (agent !== 'cursor') expect(whole.filter((e) => e.kind.startsWith('tool.')).map((e) => [e.kind, e.payload.success, e.payload.output])).toEqual([['tool.use', true, 'ok']]);
      if (parser.planTags.length > 0) expect(new Set(whole.filter((e) => e.kind === 'plan').map((e) => e.payload.planKey)).size).toBe(2);
    });
  }
});
