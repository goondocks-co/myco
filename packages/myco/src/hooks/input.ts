import { readStdin } from './read-stdin.js';
import { normalizeHookInput, type NormalizedHookInput } from './normalize.js';

export async function readHookInput(): Promise<NormalizedHookInput> {
  const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
  return normalizeHookInput(raw);
}
