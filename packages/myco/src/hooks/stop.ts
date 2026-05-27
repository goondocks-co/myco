import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';

/**
 * Parse `--phases response,transcript` from process.argv. The hook command
 * generated from manifest carries the phases this specific agent event
 * contributes to (Windsurf's response phase vs transcript phase, etc.).
 * Returns undefined when the flag is absent so the daemon falls back to
 * its default (both phases) — preserves contract for any legacy install.
 */
function parsePhasesArg(): ('response' | 'transcript')[] | undefined {
  const idx = process.argv.indexOf('--phases');
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const raw = process.argv[idx + 1];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = parts.filter((p): p is 'response' | 'transcript' =>
    p === 'response' || p === 'transcript',
  );
  return valid.length > 0 ? valid : undefined;
}

export async function main() {
  const VAULT_DIR = resolveProvisionedVaultDir();
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    if (!input.sessionId) return;

    const client = createHookDaemonClient(VAULT_DIR, { sessionId: input.sessionId });

    await client.ensureRunning({ checkStale: false });

    // Pass transcript_path and last_assistant_message from the active agent.
    // These are provided by the hook system and eliminate the need to
    // scan directories or mine the transcript for the AI response.
    await client.capturePost('/events/stop', {
      session_id: input.sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
      last_assistant_message: input.lastResponse,
      phases: parsePhasesArg(),
    });
  } catch (error) {
    process.stderr.write(`[myco] stop error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'stop');
  }
}
