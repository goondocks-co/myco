import type { RunEvent } from './events.js';
import type { Harness } from './harnesses.js';
import { stepOf } from './steps.js';

type Ending = Extract<RunEvent, { kind: 'ended' }>;

/** A run without source requires a Myco call before a successful ending or a failed alternate route. */
export function runToolUse(rules: Harness['steps'], sourceReadOnly: boolean): (event: RunEvent) => Ending | null {
  let used = false;
  return (event) => {
    if (event.kind === 'tool_call') {
      const step = stepOf(rules, event);
      const myco = step.kind === 'myco';
      used ||= myco;
      if (used || sourceReadOnly || event.status !== 'error' || step.kind === 'tool') return null;
    } else if (event.kind !== 'ended' || event.stop !== 'end_turn' || used || sourceReadOnly) return null;
    return { kind: 'ended', stop: 'error', code: 'tools_unused', detail: null };
  };
}
