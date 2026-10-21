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

const CURSOR_ALIASES = ['cursor', 'Cursor'] as const;
export const hasCursorAliasBranch = (agent: string): boolean => CURSOR_ALIASES.some((name) => name === agent);

const ONLY_CURSOR = { 'cursor': true };
export const hasCursorMapBranch = (agent: string): boolean => Object.prototype.hasOwnProperty.call(ONLY_CURSOR, agent);

const SCHEMA_SHAPED = { 'cursor': { type: 'string' } };
export const hasCursorSchemaShapedBranch = (agent: string): boolean => agent in SCHEMA_SHAPED;

export const NESTED = { fields: { 'cursor': { type: 'string' } } };
