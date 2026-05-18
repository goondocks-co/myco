/**
 * Stdio MCP entry point.
 *
 * This subprocess does NOT run an MCP server. It is a transparent JSON-RPC
 * pump between two MCP-SDK transports: a `StdioServerTransport` facing the
 * agent (claude-code, cursor, vscode-copilot, gemini, etc.) and a
 * `StreamableHTTPClientTransport` facing the daemon's in-process MCP server
 * at `/mcp`. Tool execution happens in the daemon — the same path that codex
 * already uses over native HTTP. There is one tool runtime, regardless of
 * what wire format an agent speaks.
 *
 * Each MCP-SDK transport exposes `start`, `send(message)`, `close`,
 * `onmessage`, `onclose`, `onerror`. Wiring `downstream.onmessage` to
 * `upstream.send` (and vice versa) gives us a transparent JSON-RPC proxy: the
 * agent's `initialize`, `tools/list`, `tools/call`, progress notifications,
 * and SSE-delivered responses all flow through unmodified.
 *
 * # Liveness
 *
 * The bridge can outlive both sides — the agent dies hard (kill -9, terminal
 * close, force-quit) without closing stdin cleanly, OR the daemon restarts
 * (npm upgrade, service reload, manual `myco daemon restart`, `make build`
 * + dogfood restart, etc.). Either case produced 21-hour stale bridges on
 * 2026-05-15 because no liveness gate ran after the initial bridge wiring.
 *
 * The bridge now covers both failure shapes:
 *
 *   1. **Parent-death watchdog** — periodically check `process.ppid`. When
 *      the parent dies, the OS reparents the orphan to PID 1 (init/launchd).
 *      The bridge sees this and exits cleanly. Doesn't depend on stdin EOF
 *      detection, which the MCP SDK only triggers on its next read attempt
 *      and so misses indefinite idle.
 *   2. **Daemon-health heartbeat** — periodic `/health` probe. Tight enough
 *      that an idle bridge catches a daemon restart within ~10 s without an
 *      active request to surface it.
 *   3. **Active-send self-heal (Bucket J)** — when a forwarded JSON-RPC
 *      message can't reach the daemon (the user's `make build` just replaced
 *      the daemon binary; the old http handle points at a dead socket), the
 *      bridge re-resolves daemon.json, rebuilds the upstream transport, and
 *      keeps serving. The failed message is lost (the agent's retry covers
 *      it); the bridge itself doesn't have to die so the agent doesn't have
 *      to round-trip a respawn. If the daemon stays unreachable through the
 *      probe budget, the bridge gives up and exits so the agent does respawn.
 *   4. **Lifecycle stderr log** — every state transition writes a tagged
 *      line so a "tool call hangs" investigation can read the agent's MCP
 *      stderr capture and see immediately whether the bridge has been
 *      sitting wedged, freshly spawned, or mid-reconnect.
 *
 * Heartbeat / watchdog cadence is conservative: a few seconds of latency
 * after parent/daemon death is acceptable when the alternative is a
 * day-long zombie.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { DaemonClient } from '../hooks/client.js';
import {
  REQUEST_CONTEXT_AUTH_HEADER,
  requestContextFromEnvironment,
  requestContextHeaders,
} from '../tools/request-context.js';

const STDIO_BRIDGE_TAG = '[myco stdio-bridge]';

/** Parent-death watchdog cadence. Tight enough to release zombies within
 *  ~10 s of agent death, loose enough that the polling cost is negligible. */
export const PARENT_WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Daemon-health probe cadence. The probe is a single HEAD-equivalent fetch;
 * 5 s is cheap and gives us idle-bridge recovery within ~10 s of a daemon
 * restart even when no agent message is in flight to surface the failure
 * actively. The active-send self-heal path (Bucket J) is what handles the
 * "user just ran make build and triggered an MCP call" case in well under
 * a second; the heartbeat is a background safety net.
 */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;

/** Consecutive heartbeat failures before the bridge exits. A single missed
 *  probe can happen during a daemon restart window; two in a row means the
 *  bridge's current HTTP target is stale and it should die so the agent
 *  respawns a fresh one. */
export const DAEMON_HEARTBEAT_FAILURE_THRESHOLD = 2;

/**
 * Per-message upstream-send deadline. StreamableHTTPClientTransport's
 * `send()` returns as soon as the POST is accepted (the response — long
 * tool calls included — streams back via the SSE channel, NOT via
 * send()'s return value), so this only needs to be long enough for the
 * loopback POST to complete and short enough that a hung half-open
 * socket on a dead daemon doesn't sit waiting for OS TCP keepalive
 * (often minutes by default). 30 s is generous for a loopback POST.
 */
export const UPSTREAM_SEND_TIMEOUT_MS = 30_000;

/**
 * Max re-send attempts for a single forwarded JSON-RPC request when
 * the original send trips the self-heal path. Re-sending preserves the
 * agent's contract (it sees a response, not a dropped request) without
 * requiring Claude Code's MCP client to implement its own retry layer.
 * The hard cap stops a persistent-failure scenario from looping forever.
 */
export const REQUEST_RESEND_MAX_ATTEMPTS = 2;

/**
 * Self-heal probe budget on a detected upstream failure. The bridge probes
 * `/health` up to this many times (with the backoff below) before declaring
 * the daemon truly gone and exiting. A `make build` rebuild typically
 * completes within a few seconds; this budget covers normal rebuild times
 * without giving up too eagerly on slow machines.
 */
export const SELF_HEAL_PROBE_ATTEMPTS = 5;

/** Backoff per self-heal probe attempt (ms). Total budget ≈ sum of these. */
export const SELF_HEAL_PROBE_BACKOFFS_MS: readonly number[] = [200, 500, 1_000, 2_000, 4_000];

function logErr(msg: string): void {
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  process.stderr.write(`${STDIO_BRIDGE_TAG} ${msg}\n`);
}

/**
 * Exit the bridge cleanly with a tagged reason. Centralized so every
 * lifecycle path leaves the same stderr trace shape — that's the signal
 * agents capture into their MCP logs.
 */
function exitWithReason(reason: string, code = 0): never {
  logErr(`exiting (${reason})`);
  process.exit(code);
}

/**
 * Pure predicate: has the parent process gone away since the bridge started?
 *
 * Two signals indicate parent death:
 *
 *   1. Current ppid is **1** (init/launchd) — the kernel reparented our
 *      orphan, meaning the original parent definitely died.
 *   2. Current ppid differs from the **initial** ppid — the agent's process
 *      tree shifted out from under us. (Rare in practice, but cheap to check.)
 *
 * Lifted into a pure function so unit tests can verify the predicate without
 * standing up actual parent processes.
 */
export function isParentGone(initialPpid: number, currentPpid: number): boolean {
  return currentPpid === 1 || currentPpid !== initialPpid;
}

/**
 * Start a periodic check that the bridge's parent is still alive. When the
 * parent (Claude Code, Cursor, etc.) dies without closing stdin cleanly —
 * `kill -9`, terminal force-close, OS panic — the bridge's stdin pipe stays
 * "open" from the kernel's perspective but no reader on the other end will
 * ever consume bytes. The MCP SDK doesn't push messages without a peer
 * request, so without this watchdog the bridge sits idle forever (this is
 * exactly the 21-hour zombie observed on 2026-05-15).
 */
function startParentWatchdog(): void {
  const initialPpid = process.ppid;
  const timer = setInterval(() => {
    if (isParentGone(initialPpid, process.ppid)) {
      clearInterval(timer);
      exitWithReason(`parent gone (initial_ppid=${initialPpid}, current_ppid=${process.ppid})`);
    }
  }, PARENT_WATCHDOG_INTERVAL_MS);
  // Don't keep the event loop alive solely for the watchdog — if every
  // other handle releases, let the process exit naturally.
  timer.unref();
}

/**
 * Probe `/health` once with a tight timeout. Used by both the background
 * heartbeat and the active-send self-heal path. Reads the port via the
 * `portRef` closure so the function picks up post-self-heal port changes
 * automatically.
 */
async function probeDaemonHealth(portRef: { port: number }): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${portRef.port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const body = await res.json() as { myco?: boolean };
    return body.myco === true;
  } catch {
    return false;
  }
}

/**
 * Periodically probe the daemon's /health endpoint. On
 * DAEMON_HEARTBEAT_FAILURE_THRESHOLD consecutive failures, exit cleanly so
 * the agent respawns a fresh bridge that re-reads daemon.json (handling the
 * case where the daemon restarted on a different port and the active-send
 * self-heal path didn't have a chance to fire because the bridge was idle).
 */
function startDaemonHeartbeat(portRef: { port: number }): void {
  let consecutiveFailures = 0;
  const timer = setInterval(async () => {
    const ok = await probeDaemonHealth(portRef);
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    logErr(`daemon heartbeat failure ${consecutiveFailures}/${DAEMON_HEARTBEAT_FAILURE_THRESHOLD}`);
    if (consecutiveFailures >= DAEMON_HEARTBEAT_FAILURE_THRESHOLD) {
      clearInterval(timer);
      exitWithReason(`daemon health failed ${consecutiveFailures}× — agent will respawn bridge`);
    }
  }, DAEMON_HEARTBEAT_INTERVAL_MS);
  timer.unref();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Narrow predicate: is `msg` a JSON-RPC request (i.e., expecting a
 * response)? Notifications have no `id`; requests have `id` as a
 * non-null number or string. The pump uses this to decide whether a
 * dropped message owes the agent a synthetic error response.
 */
function isJsonRpcRequest(
  msg: unknown,
): msg is { jsonrpc: '2.0'; id: number | string; method: string } {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') return false;
  if (typeof m.method !== 'string') return false;
  const id = m.id;
  return (typeof id === 'number' || typeof id === 'string') && id !== '';
}

/**
 * Race a promise against a timeout. Used to bound upstream.send so a hung
 * half-open socket from a dead daemon can't sit forever waiting for the
 * OS TCP keepalive to fire (often minutes by default).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a fresh `StreamableHTTPClientTransport` against the daemon's
 * current state. Re-reads daemon.json (via DaemonClient.getInfo) so a
 * port or auth_token change since the bridge started is picked up.
 *
 * Caller is responsible for closing the prior upstream and wiring
 * onmessage / onclose / onerror on the returned transport.
 */
function buildUpstreamForCurrentDaemon(
  vaultDir: string,
): { transport: StreamableHTTPClientTransport; port: number } | null {
  const client = new DaemonClient(vaultDir);
  const info = client.getInfo();
  if (!info) return null;
  const headers: Record<string, string> = {
    ...requestContextHeaders(requestContextFromEnvironment(process.env, vaultDir)),
    ...(info.auth_token ? { [REQUEST_CONTEXT_AUTH_HEADER]: info.auth_token } : {}),
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    { requestInit: { headers } },
  );
  return { transport, port: info.port };
}

export async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();
  const client = new DaemonClient(vaultDir);

  const ready = await client.ensureRunning();
  const info = client.getInfo();
  if (!ready || !info) {
    logErr('daemon failed to start; cannot bridge stdio MCP');
    process.exit(1);
  }

  logErr(`bridge starting (pid=${process.pid}, ppid=${process.ppid}, daemon_port=${info.port})`);

  const headers: Record<string, string> = {
    ...requestContextHeaders(requestContextFromEnvironment(process.env, vaultDir)),
    ...(info.auth_token ? { [REQUEST_CONTEXT_AUTH_HEADER]: info.auth_token } : {}),
  };
  let upstream = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    { requestInit: { headers } },
  );
  const downstream = new StdioServerTransport();

  // Port reference shared with the heartbeat so self-heal updates are
  // visible to the background watchdog without re-registering it.
  const portRef = { port: info.port };

  // Single-flight reconnect mutex. While a reconnect is in progress, new
  // downstream messages wait for it to settle before being sent.
  let reconnectInFlight: Promise<boolean> | null = null;

  /**
   * Wire all upstream handlers. Called on initial setup AND on every
   * post-self-heal rebuild so the new transport routes messages back to
   * the same downstream and we don't leak the previous instance's events.
   *
   * `onclose` fires on EVERY upstream death — daemon SIGTERM, network
   * reset, planned teardown by our own reconnect path. Conflating these
   * killed the bridge the moment a `make build` cycle restarted the
   * daemon, leaving Claude Code holding a dead bridge that it doesn't
   * auto-respawn (the next tool call hangs indefinitely). The reconnect
   * path nulls out `onclose` before tearing down the old transport, so
   * any fire we see here is daemon-driven — try the same self-heal
   * sequence the send-error path uses, and only exit if it can't
   * recover. Same single-flight (`reconnectInFlight`) prevents double-
   * firing when send-error AND onclose both observe the same death.
   */
  function wireUpstream(t: StreamableHTTPClientTransport): void {
    t.onmessage = (msg) => {
      downstream.send(msg).catch((err: Error) => logErr(`downstream send failed: ${err.message}`));
    };
    t.onclose = () => {
      logErr('upstream onclose fired — entering self-heal');
      void (async () => {
        const recovered = await reconnectUpstream();
        if (!recovered) {
          void downstream.close().finally(() =>
            exitWithReason('upstream closed and self-heal exhausted probe budget — agent will respawn bridge'),
          );
        }
      })();
    };
    t.onerror = (err) => logErr(`upstream: ${err.message}`);
  }

  /**
   * Re-resolve the daemon (re-read daemon.json) and swap upstream to a
   * fresh transport. Returns true on success; false if the daemon stays
   * unreachable through the probe budget (in which case the caller should
   * exit so the agent respawns the bridge).
   *
   * Single-flight via `reconnectInFlight`: concurrent message sends that
   * trip the failure path while a reconnect is already underway await the
   * same promise instead of each spawning their own rebuild.
   */
  async function reconnectUpstream(): Promise<boolean> {
    if (reconnectInFlight) return reconnectInFlight;
    reconnectInFlight = (async () => {
      logErr('self-heal: probing daemon and rebuilding upstream');
      for (let attempt = 0; attempt < SELF_HEAL_PROBE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          const backoff = SELF_HEAL_PROBE_BACKOFFS_MS[attempt - 1] ?? 4_000;
          await sleepMs(backoff);
        }
        const rebuilt = buildUpstreamForCurrentDaemon(vaultDir);
        if (!rebuilt) {
          logErr(`self-heal: attempt ${attempt + 1}/${SELF_HEAL_PROBE_ATTEMPTS} — no daemon.json yet`);
          continue;
        }
        // Health-check against the freshly-discovered port BEFORE swapping
        // upstream, so we don't tear down a working transport in favor of
        // a not-yet-listening one.
        const ok = await probeDaemonHealth({ port: rebuilt.port });
        if (!ok) {
          logErr(`self-heal: attempt ${attempt + 1}/${SELF_HEAL_PROBE_ATTEMPTS} — /health probe failed`);
          // Discard the just-built transport; we'll rebuild from fresh
          // daemon.json on the next attempt in case the port shifts again.
          void rebuilt.transport.close().catch(() => undefined);
          continue;
        }
        // Daemon is up at `rebuilt.port`. Tear down the old upstream
        // (suppress its onclose so it doesn't drag the bridge down),
        // swap, and wire the new one.
        const old = upstream;
        old.onclose = undefined;
        old.onerror = undefined;
        old.onmessage = undefined;
        try { await old.close(); } catch (err) {
          logErr(`self-heal: old upstream close errored (ignored): ${(err as Error).message}`);
        }
        upstream = rebuilt.transport;
        portRef.port = rebuilt.port;
        wireUpstream(upstream);
        try {
          await upstream.start();
          logErr(`self-heal: upstream rebuilt on port ${rebuilt.port}`);
          return true;
        } catch (err) {
          logErr(`self-heal: new upstream start() failed: ${(err as Error).message}`);
          // Drop through to the next attempt.
        }
      }
      logErr('self-heal: daemon stayed unreachable through probe budget');
      return false;
    })();
    const result = await reconnectInFlight;
    reconnectInFlight = null;
    return result;
  }

  // Transparent JSON-RPC pump. The agent and the daemon's MCP server
  // negotiate `initialize`, capabilities, and protocol version directly
  // through this pipe; the bridge never interprets payloads.
  //
  // When upstream.send fails (synchronous network error) OR hangs past
  // UPSTREAM_SEND_TIMEOUT_MS (half-open socket on a dead daemon), the
  // self-heal path fires: re-resolve daemon, rebuild upstream, and
  // RE-SEND the original message through the new transport. Claude
  // Code's MCP client doesn't implement its own request retry, so a
  // dropped JSON-RPC request would leave the agent waiting forever for
  // a response that never comes — which is the exact "tool call hangs
  // after make build" symptom Bucket J was supposed to fix.
  //
  // If re-send still fails after REQUEST_RESEND_MAX_ATTEMPTS, and the
  // message was a request (has an `id`), we synthesize a JSON-RPC error
  // response so the agent gets closure instead of a silent hang.
  downstream.onmessage = (msg) => {
    // Wait for any in-flight reconnect to settle before forwarding, so a
    // burst of messages during a daemon restart doesn't each try to
    // independently rebuild upstream.
    const send = async (attempt = 0): Promise<void> => {
      if (reconnectInFlight) await reconnectInFlight;
      try {
        await withTimeout(upstream.send(msg), UPSTREAM_SEND_TIMEOUT_MS, 'upstream.send');
      } catch (err) {
        const errMsg = (err as Error).message;
        logErr(`upstream send failed: ${errMsg} — entering self-heal (attempt ${attempt + 1})`);
        const recovered = await reconnectUpstream();
        if (!recovered) {
          respondWithError(msg, 'daemon unreachable; bridge exiting so agent respawns');
          exitWithReason('self-heal exhausted probe budget — agent will respawn bridge');
        }
        if (attempt < REQUEST_RESEND_MAX_ATTEMPTS) {
          logErr(`self-heal succeeded; re-sending message through rebuilt upstream`);
          return send(attempt + 1);
        }
        // Out of retries. Don't leave a JSON-RPC request unanswered.
        logErr(`upstream send still failing after ${attempt + 1} attempts; surfacing error to agent`);
        respondWithError(msg, `bridge could not deliver request after ${attempt + 1} attempts: ${errMsg}`);
      }
    };
    send().catch((err: Error) => logErr(`downstream pump error: ${err.message}`));
  };

  /**
   * Synthesize a JSON-RPC error response for a dropped request so the
   * agent gets closure. Notifications (no `id`) are dropped silently —
   * that's the JSON-RPC contract: no response is expected, no response
   * is owed. Best-effort: if downstream.send rejects, just log it; we
   * tried.
   */
  function respondWithError(originalMsg: unknown, reason: string): void {
    if (!isJsonRpcRequest(originalMsg)) return; // notifications get no response
    const errorResponse = {
      jsonrpc: '2.0' as const,
      id: originalMsg.id,
      error: {
        code: -32000,
        message: `[myco stdio-bridge] ${reason}`,
      },
    };
    void downstream.send(errorResponse).catch((err: Error) =>
      logErr(`failed to deliver synthetic error response (id=${originalMsg.id}): ${err.message}`),
    );
  }

  // When downstream closes, tear down upstream and exit.
  downstream.onclose = () => {
    void upstream.close().finally(() => exitWithReason('downstream (agent) closed'));
  };
  downstream.onerror = (err) => logErr(`downstream: ${err.message}`);

  wireUpstream(upstream);

  await upstream.start();
  await downstream.start();

  // Start liveness watchdogs only after the pipes are wired — if anything
  // fails before this point, we'll have already exited via the catch path
  // and the timers would never have fired.
  startParentWatchdog();
  startDaemonHeartbeat(portRef);

  logErr('bridge ready');
}
