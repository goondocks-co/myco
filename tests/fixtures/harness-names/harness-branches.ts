/** Source the harness-name gate reads: each `cursor` here names the Cursor harness, one on each line the gate must report. */
export const isCursor = (agent: string): boolean => agent === 'cursor';

export function nameOf(agent: string): string {
  switch (agent) {
    case 'cursor': return 'Cursor';
    default: return agent;
  }
}

export const HARNESSES = ['claude-code', 'cursor'] as const;

export const PER_HARNESS = { 'cursor': 1, 'codex': 2 };

export const ONLY = { agent: 'cursor' };
