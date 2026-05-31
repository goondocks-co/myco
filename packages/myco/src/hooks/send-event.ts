/** Shared skeleton: read stdin, POST to daemon /events, buffer on failure. */

import { createHookDaemonClient, isIgnoredEventResponse, type DaemonClient } from './client.js';
import { type NormalizedHookInput } from './normalize.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveProjectBufferDirFromRoot } from '../capture/buffer-location.js';
import { resolveProjectRoot } from '../vault/resolve.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';

type ClientResult = Awaited<ReturnType<DaemonClient['capturePost']>>;

/**
 * Classify why a hook is falling back to a buffer write. Surfaces in stderr
 * so a "session not captured" investigation can answer "did the hook reach
 * the daemon at all?" without inspecting buffer-file byte counts. Matches
 * the failure modes in `DaemonClient.capturePost`.
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

/**
 * POST a capture-critical event and, on failure, fall back to the on-disk
 * EventBuffer so `reconcileBufferBatches` can replay it on the next daemon
 * start. This is the one durability boundary every capture hook shares.
 *
 * The buffer write MUST live in the hook process: it only happens when the
 * daemon is unreachable, so there is nothing to delegate it to. Hooks stay
 * thin (AGENTS.md: "hooks must stay thin and delegate to the daemon") by
 * routing through this single helper instead of re-implementing the fallback.
 *
 * `bufferOnIgnored` (default true) also buffers when the daemon answers 200
 * with `{ ignored }`. Hooks whose replay path RE-APPLIES capture rules
 * (`user_prompt` — see reconciliation.ts) want this. `post-tool-use` passes
 * FALSE: `tool_use` replay inserts directly without re-filtering, so buffering
 * a rule-dropped tool would resurrect it on the next start.
 *
 * `bufferEvent: null` POSTs without ever buffering — e.g. a stop with no
 * assistant response to recover.
 *
 * Pass `client` to reuse an already-warmed client (e.g. after `ensureRunning`).
 */
export async function captureCriticalEvent(opts: {
  vaultDir: string;
  sessionId: string;
  hookName: string;
  endpoint: string;
  postBody: Record<string, unknown>;
  bufferEvent: Record<string, unknown> | null;
  bufferOnIgnored?: boolean;
  client?: DaemonClient;
}): Promise<ClientResult> {
  const { vaultDir, sessionId, hookName, endpoint, postBody, bufferEvent } = opts;
  const bufferOnIgnored = opts.bufferOnIgnored ?? true;
  const client = opts.client ?? createHookDaemonClient(vaultDir, { sessionId });

  const result = await client.capturePost(endpoint, postBody);

  const shouldFallback = !result.ok || (bufferOnIgnored && isIgnoredEventResponse(result.data));
  if (bufferEvent && shouldFallback) {
    // Project must be registered globally to receive a buffered write.
    // No fallback location: Grove migration taught us that "if not in
    // global, fall back to project-local" silently produces divergent
    // state. A daemon-unreachable hit on a pre-register project drops
    // with a visible stderr trace rather than a guessed location.
    const location = resolveProjectBufferDirFromRoot(resolveProjectRoot(vaultDir));
    if (location) {
      new EventBuffer(location.bufferDir, sessionId).append(bufferEvent);
      // Stderr trace so "session not captured" investigations can see the
      // buffer-fallback path firing without a daemon round-trip.
      process.stderr.write(
        `[myco] ${hookName} buffered (${classifyBufferFallback(result)}) session=${sessionId}\n`,
      );
    } else {
      process.stderr.write(
        `[myco] ${hookName} dropped (project-not-registered) session=${sessionId}\n`,
      );
    }
  }
  return result;
}

export async function sendEvent(
  hookName: string,
  buildEvent: (input: NormalizedHookInput) => Record<string, unknown>,
): Promise<void> {
  const VAULT_DIR = resolveProvisionedVaultDir();
  if (!VAULT_DIR) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const event = buildEvent(input);
    await captureHookEvent(VAULT_DIR, hookName, input, event);
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName);
  }
}

/**
 * Generic `/events` capture for simple hooks: POST `{ ...event, session_id,
 * agent, transcript_path }` and buffer the same payload on failure/ignored.
 * Thin wrapper over {@link captureCriticalEvent} so every capture path shares
 * one durability implementation.
 */
export async function captureHookEvent(
  vaultDir: string,
  hookName: string,
  input: NormalizedHookInput,
  event: Record<string, unknown>,
): Promise<void> {
  const sessionId = input.sessionId;
  if (!sessionId) return;

  const eventWithContext = { ...event, transcript_path: input.transcriptPath };
  await captureCriticalEvent({
    vaultDir,
    sessionId,
    hookName,
    endpoint: '/events',
    postBody: { ...eventWithContext, session_id: sessionId, agent: input.agent },
    bufferEvent: eventWithContext,
  });
}
