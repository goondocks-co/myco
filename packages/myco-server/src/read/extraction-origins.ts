import { PROMPT_ORIGINS } from '../ingest/kinds.js';

/** Whether a prompt supplies session instructions for titling, cards and learning. */
const INSTRUCTION_ORIGINS: Readonly<Record<(typeof PROMPT_ORIGINS)[number], boolean>> = {
  user: true,
  unknown: true,
  system: false,
  agent_dispatch: true,
  hook_injected: false,
};

/** The instruction origins an extraction page and titling material carry. */
export const READ_ORIGINS: readonly string[] = PROMPT_ORIGINS.filter((origin) => INSTRUCTION_ORIGINS[origin]);

export const isInstructionOrigin = (origin: unknown): boolean => typeof origin === 'string' && READ_ORIGINS.includes(origin);
