/** Shared skeleton: read stdin, POST to daemon /events, buffer on failure. */

import { createHookDaemonClient, isIgnoredEventResponse } from './client.js';
import { type NormalizedHookInput } from './normalize.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveProjectBufferDirFromRoot } from '../capture/buffer-location.js';
import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Classify why a hook is falling back to a buffer write. Surfaces in stderr
 * so a "session not captured" investigation can answer "did the hook reach
 * the daemon at all?" without inspecting buffer-file byte counts. Matches
 * the failure modes in `DaemonClient.capturePost`.
 *
 * Exported so the two hook handlers with their own buffer-write logic
 * (`user-prompt-submit.ts`, `post-tool-use.ts`) classify the same way as
 * sendEvent — one observability surface across every capture hook.
 */
export function classifyBufferFallback(result: { ok: boolean; data?: unknown }): string {
  if (result.ok) {
    if (isIgnoredEventResponse(result.data)) {
      const ignored = (result.data as { ignored?: unknown } | undefined)?.ignored;
      return `daemon-ignored:${typeof ignored === 'string' ? ignored : 'unknown'}`;
    }
    return 'unknown';
  }
  // transport failure (fetch threw, daemon.json missing, recovery path)
  // OR non-2xx HTTP response (`result.data` may be the parsed error envelope)
  if (result.data !== undefined) {
    return 'http-error';
  }
  return 'transport-failure';
}

export async function sendEvent(
  hookName: string,
  buildEvent: (input: NormalizedHookInput) => Record<string, unknown>,
): Promise<void> {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const event = buildEvent(input);
    const eventWithContext = {
      ...event,
      transcript_path: input.transcriptPath,
    };

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });
    const result = await client.capturePost(
      '/events',
      { ...eventWithContext, session_id: sessionId, agent: symbiont },
    );

    // Buffer on transport failure OR server-side `ignored` so reconcile can replay it.
    if (!result.ok || isIgnoredEventResponse(result.data)) {
      // Project must be registered globally to receive a buffered write.
      // No fallback location: Grove migration taught us that "if not in
      // global, fall back to project-local" silently produces divergent
      // state. Auto-registration on first hook (Step 13) covers live
      // capture; until that lands, a daemon-unreachable hit on a
      // pre-register project drops with a visible stderr trace.
      const location = resolveProjectBufferDirFromRoot(resolveProjectRoot(VAULT_DIR));
      if (!location) {
        process.stderr.write(
          `[myco] ${hookName} dropped (project-not-registered) session=${sessionId}\n`,
        );
        return;
      }
      const buffer = new EventBuffer(location.bufferDir, sessionId);
      buffer.append(eventWithContext);
      // Stderr log so "session not captured" investigations can see the
      // buffer-fallback path firing — previously this was completely silent,
      // which is exactly how the prod-daemon stop-responding-after-restart
      // class of bug went undiagnosed for hours at a time. The agent
      // captures hook stderr (or surfaces it in its log), so this is the
      // shortest path to observability without a daemon round-trip.
      process.stderr.write(
        `[myco] ${hookName} buffered (${classifyBufferFallback(result)}) session=${sessionId}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName);
  }
}
