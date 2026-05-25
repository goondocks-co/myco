import { createHookDaemonClient } from './client.js';
import { classifyBufferFallback } from './send-event.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveProjectBufferDirFromRoot } from '../capture/buffer-location.js';
import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

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

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });

    // Capture writes use service-aware recovery on transport failure, then
    // still buffer locally so reconcile can replay on the next successful start.
    const result = await client.capturePost('/events', {
      type: 'tool_use',
      tool_name: input.toolName,
      tool_input: input.toolInput,
      output_preview: typeof input.toolOutput === 'string' ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
      session_id: sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
    });

    if (!result.ok) {
      const location = resolveProjectBufferDirFromRoot(resolveProjectRoot(VAULT_DIR));
      if (!location) {
        process.stderr.write(
          `[myco] post-tool-use dropped (project-not-registered) session=${sessionId}\n`,
        );
        return;
      }
      const buffer = new EventBuffer(location.bufferDir, sessionId);
      buffer.append({
        type: 'tool_use',
        tool_name: input.toolName,
        tool_input: input.toolInput,
        output_preview: typeof input.toolOutput === 'string' ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
        transcript_path: input.transcriptPath,
      });
      // Mirror the observability contract from send-event.ts and
      // user-prompt-submit.ts — every buffer-fallback path leaves a stderr
      // trace classifying the reason.
      process.stderr.write(
        `[myco] post-tool-use buffered (${classifyBufferFallback(result)}) session=${sessionId}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`[myco] post-tool-use error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'post-tool-use');
  }
}
