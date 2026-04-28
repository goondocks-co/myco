import { createHash } from 'node:crypto';

/**
 * Bumping this constant invalidates every stored canopy_maps row on the next
 * task run. Bump whenever the task prompt or the inputs-hash recipe itself
 * changes in a way that should force a cold-start regeneration.
 */
export const MAP_TASK_PROMPT_VERSION = 'v1';

export interface CanopyEntryInput {
  path: string;
  content_hash: string;
  llm_description: string | null;
}

export interface RulesFileInput {
  filename: string;
  content_hash: string;
}

export interface InputsHashInput {
  canopyEntries: CanopyEntryInput[];
  rulesFiles: RulesFileInput[];
  promptVersion: string;
}

export function computeInputsHash(input: InputsHashInput): string {
  const sortedEntries = [...input.canopyEntries].sort((a, b) => a.path.localeCompare(b.path));
  const sortedRules = [...input.rulesFiles].sort((a, b) => a.filename.localeCompare(b.filename));

  const canonical = JSON.stringify({
    canopy: sortedEntries.map((e) => [e.path, e.content_hash, e.llm_description ?? '']),
    rules: sortedRules.map((r) => [r.filename, r.content_hash]),
    prompt: input.promptVersion,
  });

  return createHash('sha256').update(canonical).digest('hex');
}
