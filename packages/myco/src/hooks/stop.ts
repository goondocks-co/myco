import { captureCriticalEvent } from './send-event.js';
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

    // The Stop event carries the turn's assistant response (last_assistant_message)
    // and triggers transcript mining. /events/stop is queued BY DESIGN — it
    // answers { ok, queued: true } with no persist outcome — so the shared
    // capture-critical path buffers every summary-bearing stop unless the
    // daemon deliberately ignored it (a gate rejection like invalid-session
    // or ephemeral-sub-invocation is not lost data). reconcileBufferBatches
    // replays the copy (reconciliation.ts `type:'stop'`, idempotent — only
    // sets response_summary while NULL), so a turn the queue already
    // persisted converges as a no-op. `bufferEvent: null` when there's no
    // response to recover, so an empty stop never writes a no-op buffer row.
    const summary = typeof input.lastResponse === 'string' ? input.lastResponse.trim() : '';
    await captureCriticalEvent({
      vaultDir: VAULT_DIR,
      sessionId: input.sessionId,
      hookName: 'stop',
      endpoint: '/events/stop',
      postBody: {
        session_id: input.sessionId,
        agent: input.agent,
        transcript_path: input.transcriptPath,
        last_assistant_message: input.lastResponse,
        phases: parsePhasesArg(),
      },
      bufferEvent: summary
        ? {
            type: 'stop',
            last_assistant_message: input.lastResponse,
            transcript_path: input.transcriptPath,
            agent: input.agent,
          }
        : null,
    });
  } catch (error) {
    process.stderr.write(`[myco] stop error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'stop');
  }
}
