import { PROMPT_ORIGINS } from '../ingest/kinds.js';

/** Whether extraction reads a prompt of each declared origin. */
export const EXTRACTION_ORIGINS: Readonly<Record<(typeof PROMPT_ORIGINS)[number], boolean>> = {
  user: true,
  unknown: true,
  system: false,
  agent_dispatch: false,
  hook_injected: false,
};

/** The origins an extraction page carries. */
export const READ_ORIGINS: readonly string[] = PROMPT_ORIGINS.filter((origin) => EXTRACTION_ORIGINS[origin]);
