import { DaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
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

    const client = new DaemonClient(VAULT_DIR);

    // DaemonClient auto-spawns on missing daemon.json or fetch failure,
    // coalesced within DAEMON_SPAWN_COALESCE_MS so frequent PostToolUse
    // firings don't fork extra daemons. This call still buffers on live
    // failure; reconcile replays on the next successful start.
    const result = await client.post('/events', {
      type: 'tool_use',
      tool_name: input.toolName,
      tool_input: input.toolInput,
      output_preview: typeof input.toolOutput === 'string' ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
      session_id: sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
    });

    if (!result.ok) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({
        type: 'tool_use',
        tool: input.toolName,
        input: input.toolInput,
        output_preview: typeof input.toolOutput === 'string' ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined,
        transcript_path: input.transcriptPath,
      });
    }
  } catch (error) {
    process.stderr.write(`[myco] post-tool-use error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'post-tool-use');
  }
}
