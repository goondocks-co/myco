/**
 * Ollama model context window management.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Timeout for Ollama model pre-load request (ms). */
const OLLAMA_PRELOAD_TIMEOUT_MS = 30_000;

/**
 * Ensure an Ollama model variant exists with the desired context length.
 *
 * The Anthropic-compatible endpoint (/v1/messages) always loads models at
 * default context — it ignores /api/chat preloads and API-created params.
 * The only reliable way is `ollama create` with a Modelfile containing
 * `PARAMETER num_ctx`. Creates a variant named `{model}-ctx{contextLength}`.
 */
export async function ensureOllamaContextVariant(
  model: string,
  contextLength: number,
): Promise<string> {

  const baseName = model.replace(/:latest$/, '');
  const variantName = `${baseName}-ctx${contextLength}`;

  try {
    // Check if variant already exists
    execFileSync('ollama', ['show', variantName], { stdio: 'ignore' });
    return variantName;
  } catch {
    // Doesn't exist — create it
  }

  try {
    const modelfilePath = join(tmpdir(), `myco-modelfile-${Date.now()}`);
    writeFileSync(modelfilePath, `FROM ${model}\nPARAMETER num_ctx ${contextLength}\n`);
    execFileSync('ollama', ['create', variantName, '-f', modelfilePath], {
      stdio: 'ignore',
      timeout: OLLAMA_PRELOAD_TIMEOUT_MS,
    });
    try { unlinkSync(modelfilePath); } catch { /* cleanup best-effort */ }
    return variantName;
  } catch {
    return model; // Fall back to original
  }
}
