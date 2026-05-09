import { createHookDaemonClient, isIgnoredEventResponse } from './client.js';
import { readHookInput } from './input.js';
import { evaluateUserPromptRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

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
    // actually gets a response; falls back to the buffer path on timeout.
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

    // Kind classification happens on the daemon; Stop-time reconciler repairs it.
    const eventResult = await client.post('/events', {
      type: 'user_prompt',
      prompt,
      session_id: sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
    });

    // Buffer on transport failure OR server-side `ignored` so the event is
    // recoverable by reconcileBufferBatches on the next daemon start.
    if (!eventResult.ok || isIgnoredEventResponse(eventResult.data)) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({ type: 'user_prompt', prompt, transcript_path: input.transcriptPath });
    }

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
