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
