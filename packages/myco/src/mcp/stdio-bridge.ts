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
 * (npm upgrade, service reload, manual `myco daemon restart`). Either case
 * produced 21-hour stale bridges on 2026-05-15 because no liveness gate ran
 * after the initial bridge wiring. Three watchdogs now cover the gap:
 *
 *   1. **Parent-death watchdog** — periodically check `process.ppid`. When
 *      the parent dies, the OS reparents the orphan to PID 1 (init/launchd).
 *      The bridge sees this and exits cleanly. Doesn't depend on stdin EOF
 *      detection, which the MCP SDK only triggers on its next read attempt
 *      and so misses indefinite idle.
 *   2. **Daemon-health heartbeat** — periodic `/health` probe. After two
 *      consecutive failures, the bridge exits cleanly; the agent's next
 *      tool call respawns a fresh bridge that re-resolves the daemon's
 *      current port from daemon.json.
 *   3. **Lifecycle stderr log** — every state transition writes a tagged
 *      line so a "tool call hangs" investigation can read the agent's MCP
 *      stderr capture and see immediately whether the bridge has been
 *      sitting wedged or is freshly spawned.
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

/** Daemon-health probe cadence. The probe is a single HEAD-equivalent fetch;
 *  every 30 s is cheap and gives us recovery within a minute. */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 30_000;

/** Consecutive heartbeat failures before the bridge exits. A single missed
 *  probe can happen during a daemon restart window; two in a row means the
 *  bridge's current HTTP target is stale and it should die so the agent
 *  respawns a fresh one. */
export const DAEMON_HEARTBEAT_FAILURE_THRESHOLD = 2;

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
 * Periodically probe the daemon's /health endpoint. On
 * DAEMON_HEARTBEAT_FAILURE_THRESHOLD consecutive failures, exit cleanly so
 * the agent respawns a fresh bridge that re-reads daemon.json (handling the
 * case where the daemon restarted on a different port).
 */
function startDaemonHeartbeat(port: number): void {
  let consecutiveFailures = 0;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`health ${res.status}`);
      const body = await res.json() as { myco?: boolean };
      if (body.myco !== true) throw new Error('health body missing myco flag');
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      logErr(`daemon heartbeat failure ${consecutiveFailures}/${DAEMON_HEARTBEAT_FAILURE_THRESHOLD}: ${(err as Error).message}`);
      if (consecutiveFailures >= DAEMON_HEARTBEAT_FAILURE_THRESHOLD) {
        clearInterval(timer);
        exitWithReason(`daemon health failed ${consecutiveFailures}× — agent will respawn bridge`);
      }
    }
  }, DAEMON_HEARTBEAT_INTERVAL_MS);
  timer.unref();
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

  // G4: context-switching headers (project/grove ids) must be paired with
  // the daemon-issued bearer token. The host (e.g. claude-code) spawns this
  // bridge with a clean env, so MYCO_DAEMON_AUTH is unset — recover the
  // token from daemon.json via `info.auth_token`.
  const headers: Record<string, string> = {
    ...requestContextHeaders(requestContextFromEnvironment(process.env, vaultDir)),
    ...(info.auth_token ? { [REQUEST_CONTEXT_AUTH_HEADER]: info.auth_token } : {}),
  };
  const upstream = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    { requestInit: { headers } },
  );
  const downstream = new StdioServerTransport();

  // Transparent JSON-RPC pump. The agent and the daemon's MCP server
  // negotiate `initialize`, capabilities, and protocol version directly
  // through this pipe; the bridge never interprets payloads.
  downstream.onmessage = (msg) => {
    upstream.send(msg).catch((err: Error) => logErr(`upstream send failed: ${err.message}`));
  };
  upstream.onmessage = (msg) => {
    downstream.send(msg).catch((err: Error) => logErr(`downstream send failed: ${err.message}`));
  };

  // When either side closes, tear down the other and exit.
  downstream.onclose = () => {
    void upstream.close().finally(() => exitWithReason('downstream (agent) closed'));
  };
  upstream.onclose = () => {
    void downstream.close().finally(() => exitWithReason('upstream (daemon) closed'));
  };

  downstream.onerror = (err) => logErr(`downstream: ${err.message}`);
  upstream.onerror = (err) => logErr(`upstream: ${err.message}`);

  await upstream.start();
  await downstream.start();

  // Start liveness watchdogs only after the pipes are wired — if anything
  // fails before this point, we'll have already exited via the catch path
  // and the timers would never have fired.
  startParentWatchdog();
  startDaemonHeartbeat(info.port);

  logErr('bridge ready');
}
