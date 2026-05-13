/**
 * PreToolUse hook handler.
 *
 * Calls the daemon's /canopy/inject endpoint and, if the daemon offers a
 * blob, writes it back to the agent via hookSpecificOutput.additionalContext
 * using the symbiont's hook-response format.
 *
 * Match post-tool-use.ts's graceful-failure stance: any error degrades to
 * an empty hook response so the agent's tool call is never blocked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import { getManifestByName } from '../symbionts/detect.js';
import { resolveCanopyReadTool } from '../symbionts/canopy-read-tools.js';

const INJECT_TIMEOUT_MS = 1500;

interface InjectOk {
  inject: true;
  blob: string;
  injectionTokens: number;
  path: string;
}
interface InjectSkip {
  inject: false;
  reason?: string;
}
type InjectResponse = InjectOk | InjectSkip;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseInjectResponse(data: unknown): InjectResponse | null {
  const obj = asObject(data);
  if (!obj || typeof obj.inject !== 'boolean') return null;
  if (obj.inject === true && typeof obj.blob === 'string' && typeof obj.injectionTokens === 'number') {
    return {
      inject: true,
      blob: obj.blob,
      injectionTokens: obj.injectionTokens,
      path: typeof obj.path === 'string' ? obj.path : '',
    };
  }
  return { inject: false, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
}

export async function main(): Promise<void> {
  let symbiont: string | undefined;
  let blob: string | undefined;

  try {
    const vaultDir = resolveVaultDir();
    if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) return;

    const input = await readHookInput();
    symbiont = input.agent;

    if (!input.sessionId) return;
    if (!input.toolName) return;

    const manifest = getManifestByName(input.agent);
    if (!manifest) return;

    const resolved = resolveCanopyReadTool(manifest, input.toolName, input.toolInput);
    if (!resolved) return;

    const client = createHookDaemonClient(vaultDir, { sessionId: input.sessionId });
    const result = await client.post(
      '/canopy/inject',
      {
        sessionId: input.sessionId,
        agent: input.agent,
        // Normalize to the daemon's expected shape (file_path) regardless of
        // how this symbiont's tool_input was structured.
        toolInput: { file_path: resolved.filePath },
      },
      { timeoutMs: INJECT_TIMEOUT_MS },
    );

    if (!result.ok) return; // Daemon down / spawning — empty response.

    const parsed = parseInjectResponse(result.data);
    if (parsed?.inject === true && parsed.blob) {
      blob = parsed.blob;
    }
  } catch (error) {
    process.stderr.write(`[myco] pre-tool-use error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'pre-tool-use', blob ? { additionalContext: blob } : {});
  }
}
