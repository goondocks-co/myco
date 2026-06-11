/** Shared skeleton: read stdin, POST to daemon /events, buffer on failure. */

import { createHookDaemonClient, isIgnoredEventResponse, type DaemonClient } from './client.js';
import { type NormalizedHookInput } from './normalize.js';
import { readHookInput } from './input.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveProjectBufferDirFromRoot } from '../capture/buffer-location.js';
import { captureEventPolicy } from '../capture/event-policy.js';
import { resolveProjectRoot } from '../vault/resolve.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';

type ClientResult = Awaited<ReturnType<DaemonClient['capturePost']>>;

function responseField(data: unknown, field: string): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as Record<string, unknown>)[field];
}

/**
 * The hook-side buffer-fallback decision over the daemon's honest response
 * contract. One row per response shape:
 *
 *   - `!ok` (transport failure, timeout, non-2xx)        → BUFFER. The
 *     daemon may have completed the work before the failure; content-keyed
 *     convergence collapses that duplicate on replay.
 *   - `ok` + `persisted: true`                           → nothing.
 *   - `ok` + `persisted: false` + `buffered: true`       → nothing. The
 *     daemon-side append is the durable copy and the daemon cleared the
 *     session's converged mark; hook re-buffering is the double-buffer trap.
 *   - `ok` + `persisted: false` + `buffered: false`      → BUFFER. The one
 *     honest-fallback case: the daemon could not persist AND holds no
 *     buffered copy (missing grove/project request context, append failure).
 *   - `ok` + `ignored` + `persisted` present             → never buffer. A
 *     contract-aware daemon's ignore is deliberate (capture rule, dedup,
 *     tombstone) — ignored ≠ lost, and buffering it re-creates the noise
 *     the gated-resurrection path exists to refuse.
 *   - `ok` with NO `persisted` field (LEGACY daemon during mixed-version
 *     rollout, and every /events/stop response — the stop pipeline is
 *     queued and never reports a persist outcome) → the policy table's
 *     legacy columns: buffer on `ignored` only when the event type's
 *     `legacyBufferOnIgnored` says so.
 */
export function shouldBufferFallback(
  result: { ok: boolean; data?: unknown },
  eventType: string | undefined,
): boolean {
  if (!result.ok) return true;
  const persisted = responseField(result.data, 'persisted');
  if (typeof persisted === 'boolean') {
    if (isIgnoredEventResponse(result.data)) return false;
    if (persisted) return false;
    return responseField(result.data, 'buffered') !== true;
  }
  if (isIgnoredEventResponse(result.data)) {
    return captureEventPolicy(eventType).legacyBufferOnIgnored;
  }
  return false;
}

/**
 * Classify why a hook is falling back to a buffer write. Surfaces in stderr
 * so a "session not captured" investigation can answer "did the hook reach
 * the daemon at all?" without inspecting buffer-file byte counts. Matches
 * the failure modes in `DaemonClient.capturePost` plus the honest-contract
 * `persisted:false, buffered:false` outcome.
 */
export function classifyBufferFallback(result: { ok: boolean; data?: unknown }): string {
  if (result.ok) {
    if (isIgnoredEventResponse(result.data)) {
      const ignored = (result.data as { ignored?: unknown } | undefined)?.ignored;
      return `daemon-ignored:${typeof ignored === 'string' ? ignored : 'unknown'}`;
    }
    if (responseField(result.data, 'persisted') === false) {
      return 'daemon-unpersisted';
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
 * POST a capture-critical event and, when the response says no durable copy
 * exists daemon-side, fall back to the on-disk EventBuffer so
 * `reconcileBufferBatches` can replay it. This is the one durability
 * boundary every capture hook shares; the fallback decision lives entirely
 * in {@link shouldBufferFallback}, driven by the shared capture policy
 * table — hooks carry no per-hook buffering flags.
 *
 * The buffer write MUST live in the hook process: it only happens when the
 * daemon holds no copy, so there is nothing to delegate it to. Hooks stay
 * thin (AGENTS.md: "hooks must stay thin and delegate to the daemon") by
 * routing through this single helper instead of re-implementing the fallback.
 *
 * The buffered copy is enriched with `agent` (and `origin`, when the POST
 * carried one the bufferEvent lacks) from the POST body, so satellite
 * consumers of the buffer — resurrection's capture gate, replay's manifest
 * re-evaluation — see the same identity the live daemon path saw.
 *
 * `bufferEvent: null` POSTs without ever buffering — e.g. a stop with no
 * assistant response to recover.
 *
 * Fail-open: a throwing buffer write is traced to stderr and swallowed —
 * no path here may propagate into the agent's hook execution.
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
  client?: DaemonClient;
}): Promise<ClientResult> {
  const { vaultDir, sessionId, hookName, endpoint, postBody, bufferEvent } = opts;
  const client = opts.client ?? createHookDaemonClient(vaultDir, { sessionId });

  const result = await client.capturePost(endpoint, postBody);

  const eventType = typeof postBody.type === 'string'
    ? postBody.type
    : typeof bufferEvent?.type === 'string' ? bufferEvent.type : undefined;
  if (bufferEvent && shouldBufferFallback(result, eventType)) {
    try {
      // Project must be registered globally to receive a buffered write.
      // No fallback location: Grove migration taught us that "if not in
      // global, fall back to project-local" silently produces divergent
      // state. A daemon-unreachable hit on a pre-register project drops
      // with a visible stderr trace rather than a guessed location.
      const location = resolveProjectBufferDirFromRoot(resolveProjectRoot(vaultDir));
      if (location) {
        const enriched: Record<string, unknown> = { ...bufferEvent };
        if (postBody.agent !== undefined || bufferEvent.agent !== undefined) {
          enriched.agent = postBody.agent ?? bufferEvent.agent;
        }
        if (postBody.origin !== undefined && bufferEvent.origin === undefined) {
          enriched.origin = postBody.origin;
        }
        new EventBuffer(location.bufferDir, sessionId).append(enriched);
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
    } catch (error) {
      process.stderr.write(
        `[myco] ${hookName} buffer write failed: ${(error as Error).message} session=${sessionId}\n`,
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
 * agent, transcript_path }` and buffer the same payload when the response
 * warrants it. Thin wrapper over {@link captureCriticalEvent} so every
 * capture path shares one durability implementation.
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
