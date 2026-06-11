import { createHookDaemonClient } from './client.js';
import { captureCriticalEvent } from './send-event.js';
import { readHookInput } from './input.js';
import { evaluateUserPromptRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';

export async function main() {
  const VAULT_DIR = resolveProvisionedVaultDir();
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const rawPrompt = input.prompt ?? '';
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const transcriptMeta = input.transcriptPath ? readTranscriptMeta(input.transcriptPath) : undefined;
    const decision = evaluateUserPromptRules(input.agent, {
      prompt: rawPrompt,
      transcriptPath: input.transcriptPath,
      transcriptMeta: transcriptMeta ?? undefined,
    });

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });
    // Await health so context injection on the first prompt after a reboot
    // actually gets a response; capture falls back to the buffer path on timeout.
    await client.ensureRunning();

    if (decision.action === 'drop') {
      // Drop rule fired — cascade-delete the session row SessionStart registered.
      // Session-maintenance sweep catches any stragglers if this request fails.
      process.stderr.write(`[myco] user-prompt-submit: dropped (${decision.reason ?? 'rule'})\n`);
      await client.delete(`/api/sessions/${sessionId}`);
      writeHookResponse(symbiont, 'user-prompt-submit');
      return;
    }

    const prompt = decision.action === 'rewrite' ? decision.prompt : rawPrompt;
    if (decision.action === 'rewrite') {
      process.stderr.write(`[myco] user-prompt-submit: rewritten (${decision.reason ?? 'rule'})\n`);
    }
    // Forward `origin` only when the rule actually classified it. The daemon's
    // toPromptBatchOrigin coerces missing/invalid values to 'human', so omitting
    // is equivalent — and keeps a single source of truth for the default.
    const originField = decision.origin ? { origin: decision.origin } : undefined;

    // Kind classification happens on the daemon; Stop-time reconciler repairs it.
    // Buffer fallback (shouldBufferFallback): a transport failure buffers, and
    // replay re-applies the capture rule (classifyNextPromptDecision,
    // capture/event-policy.ts `regate`) so a buffered prompt is re-filtered
    // rather than blindly re-inserted. Reuse the warmed client.
    await captureCriticalEvent({
      vaultDir: VAULT_DIR,
      sessionId,
      hookName: 'user-prompt-submit',
      endpoint: '/events',
      postBody: {
        type: 'user_prompt',
        prompt,
        ...originField,
        session_id: sessionId,
        agent: input.agent,
        transcript_path: input.transcriptPath,
      },
      bufferEvent: { type: 'user_prompt', prompt, ...originField, transcript_path: input.transcriptPath },
      client,
    });

    const contextResult = await client.post('/context/prompt', {
      prompt,
      session_id: sessionId,
    });

    // `Session::` line matches daemon context injection format (Branch::, Session::).
    const sessionLine = `Session:: \`${sessionId}\``;
    const contextText = contextResult.ok && contextResult.data?.text
      ? `${contextResult.data.text}\n${sessionLine}`
      : sessionLine;

    writeHookResponse(symbiont, 'user-prompt-submit', { additionalContext: contextText });
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit error: ${(error as Error).message}\n`);
    writeHookResponse(symbiont, 'user-prompt-submit');
  }
}
