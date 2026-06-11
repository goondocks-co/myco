import { captureCriticalEvent } from './send-event.js';
import { readHookInput } from './input.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../constants.js';

export async function main() {
  const VAULT_DIR = resolveProvisionedVaultDir();
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    // Drop PostToolUse fires that carry no tool name. Some symbionts
    // (notably Antigravity) emit PostToolUse for non-tool steps where
    // the field-mapped `toolCall.name` resolves to undefined — sending
    // those to the daemon produces blank activity rows that clutter
    // the Sessions UI with no useful data. The agent's real tool
    // invocations always carry a name.
    if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
      process.stderr.write(`[myco] post-tool-use dropped (no tool_name) symbiont=${symbiont ?? '?'} session=${sessionId}\n`);
      return;
    }

    const outputPreview = typeof input.toolOutput === 'string'
      ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)
      : undefined;

    // Buffer-fallback policy lives in the shared capture policy table
    // (capture/event-policy.ts): tool_use replays directly without
    // re-evaluating capture rules, so its legacy column never buffers a
    // daemon-ignored tool — that would resurrect it on the next start.
    // A transport failure (`!ok`) still buffers so reconcile can replay it.
    await captureCriticalEvent({
      vaultDir: VAULT_DIR,
      sessionId,
      hookName: 'post-tool-use',
      endpoint: '/events',
      postBody: {
        type: 'tool_use',
        tool_name: input.toolName,
        tool_input: input.toolInput,
        output_preview: outputPreview,
        session_id: sessionId,
        agent: input.agent,
        transcript_path: input.transcriptPath,
      },
      bufferEvent: {
        type: 'tool_use',
        tool_name: input.toolName,
        tool_input: input.toolInput,
        output_preview: outputPreview,
        transcript_path: input.transcriptPath,
      },
    });
  } catch (error) {
    process.stderr.write(`[myco] post-tool-use error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'post-tool-use');
  }
}
