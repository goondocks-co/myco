/** Stdio JSON-RPC pump for the credential's Deployment, with bounded reconnect and parent-death detection. */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { credentialRequiredError } from './credential-refusal.js';
import { DEPLOYMENT_HEARTBEAT_INTERVAL_MS, DEPLOYMENT_SELF_HEAL_MAX_ATTEMPTS, declaredCredentialSource, deploymentTransport, probeDeploymentHealth, resolveDeploymentUpstream } from './deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
const STDIO_BRIDGE_TAG = '[myco stdio-bridge]';

export const PARENT_WATCHDOG_INTERVAL_MS = 10_000;

export const UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD = 2;

export const UPSTREAM_SEND_TIMEOUT_MS = 30_000;

export const REQUEST_RESEND_MAX_ATTEMPTS = 2;

export const SELF_HEAL_PROBE_BACKOFFS_MS: readonly number[] = [200, 500, 1_000, 2_000, 5_000];

function logErr(msg: string): void {
  process.stderr.write(`${STDIO_BRIDGE_TAG} ${msg}\n`);
}

function exitWithReason(reason: string, code = 0): never {
  logErr(`exiting (${reason})`);
  process.exit(code);
}

export function isParentGone(initialPpid: number, currentPpid: number): boolean {
  return currentPpid === 1 || currentPpid !== initialPpid;
}

function startParentWatchdog(): void {
  const initialPpid = process.ppid;
  const timer = setInterval(() => {
    if (isParentGone(initialPpid, process.ppid)) {
      clearInterval(timer);
      exitWithReason(`parent gone (initial_ppid=${initialPpid}, current_ppid=${process.ppid})`);
    }
  }, PARENT_WATCHDOG_INTERVAL_MS);

  timer.unref();
}

function startUpstreamHeartbeat(
  probe: () => Promise<boolean>,
  triggerSelfHeal: () => void,
  intervalMs: number = DEPLOYMENT_HEARTBEAT_INTERVAL_MS,
): void {
  let consecutiveFailures = 0;
  const timer = setInterval(async () => {
    const ok = await probe();
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    logErr(`Deployment heartbeat failure ${consecutiveFailures}/${UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD}`);
    if (consecutiveFailures >= UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD) {
      consecutiveFailures = 0; // reset so we don't double-fire
      logErr('heartbeat threshold reached — triggering self-heal');
      triggerSelfHeal();
    }
  }, intervalMs);
  timer.unref();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

interface Upstream {
  transport: StreamableHTTPClientTransport;
  probe: () => Promise<boolean>;
  label: string;
}

interface UpstreamSource {
  describe: string;

  first(): Promise<Upstream | null>;

  resolve(): Upstream | null;

  heartbeatMs: number;

  maxHealAttempts: number | null;
}

function deploymentUpstreamSource(source: CredentialSource): UpstreamSource {
  const resolve = (): Upstream | null => {
    const upstream = resolveDeploymentUpstream(source, { cwd: process.cwd(), env: process.env, invokedBy: 'mcp' });
    if (!upstream) return null;
    return {
      transport: deploymentTransport(upstream),
      probe: () => probeDeploymentHealth(upstream.healthUrl),
      label: `deployment ${upstream.mcpUrl.origin} project ${upstream.projectId} (credential: ${source})`,
    };
  };
  return {
    describe: `deployment (credential: ${source})`,

    async first() {
      const upstream = resolve();
      if (!upstream) return null;
      if (!(await upstream.probe())) {
        logErr(`${upstream.label}: health probe failed at startup`);
        return null;
      }
      return upstream;
    },
    resolve,
    heartbeatMs: DEPLOYMENT_HEARTBEAT_INTERVAL_MS,
    maxHealAttempts: DEPLOYMENT_SELF_HEAL_MAX_ATTEMPTS,
  };
}

export async function main(): Promise<void> {
  let source: CredentialSource | null;
  try {
    source = declaredCredentialSource(process.argv);
  } catch (err) {
    logErr((err as Error).message);
    process.exit(2);
  }
  if (source === null) {
    logErr(credentialRequiredError().message);
    process.exit(1);
  }
  const upstreamSource = deploymentUpstreamSource(source);
  const initial = await upstreamSource.first();
  if (!initial) {
    logErr(`${upstreamSource.describe}: no upstream to bridge stdio MCP to`);
    process.exit(1);
  }

  logErr(`bridge starting (pid=${process.pid}, ppid=${process.ppid}, upstream=${initial.label})`);

  let upstream = initial.transport;

  let probe = initial.probe;
  const downstream = new StdioServerTransport();

  let reconnectInFlight: Promise<boolean> | null = null;


  function wireUpstream(t: StreamableHTTPClientTransport): void {
    t.onmessage = (msg) => {
      downstream.send(msg).catch((err: Error) => logErr(`downstream send failed: ${err.message}`));
    };
    t.onclose = () => {
      logErr('upstream onclose fired — entering self-heal');
      void reconnectUpstream().catch((err: Error) =>
        logErr(`onclose-triggered self-heal failed unexpectedly: ${err.message}`),
      );
    };
    t.onerror = (err) => logErr(`upstream: ${err.message}`);
  }


  async function reconnectUpstream(): Promise<boolean> {
    if (reconnectInFlight) return reconnectInFlight;
    reconnectInFlight = (async () => {
      logErr('self-heal: probing Deployment and rebuilding upstream');
      for (let attempt = 0; ; attempt++) {
        if (upstreamSource.maxHealAttempts !== null && attempt >= upstreamSource.maxHealAttempts) {
          logErr(`self-heal: ${upstreamSource.describe} did not answer in ${attempt} attempts; the waiting request is answered with an error`);
          return false;
        }
        if (attempt > 0) {
          const backoffIdx = Math.min(attempt - 1, SELF_HEAL_PROBE_BACKOFFS_MS.length - 1);
          await sleepMs(SELF_HEAL_PROBE_BACKOFFS_MS[backoffIdx]!);
        }
        const rebuilt = upstreamSource.resolve();
        if (!rebuilt) {
          if (attempt === 0 || attempt % 5 === 0) {
            logErr(`self-heal: attempt ${attempt + 1} — ${upstreamSource.describe} has no upstream yet, retrying`);
          }
          continue;
        }

        const ok = await rebuilt.probe();
        if (!ok) {
          if (attempt === 0 || attempt % 5 === 0) {
            logErr(`self-heal: attempt ${attempt + 1} — /health probe failed, retrying`);
          }
          void rebuilt.transport.close().catch(() => undefined);
          continue;
        }

        const old = upstream;
        old.onclose = undefined;
        old.onerror = undefined;
        old.onmessage = undefined;
        try { await old.close(); } catch (err) {
          logErr(`self-heal: old upstream close errored (ignored): ${(err as Error).message}`);
        }
        upstream = rebuilt.transport;
        probe = rebuilt.probe;
        wireUpstream(upstream);
        try {
          await upstream.start();
          logErr(`self-heal: upstream rebuilt (${rebuilt.label}) after ${attempt + 1} attempts`);
          return true;
        } catch (err) {
          logErr(`self-heal: new upstream start() failed: ${(err as Error).message} — continuing to retry`);

        }
      }
    })();
    const result = await reconnectInFlight;
    reconnectInFlight = null;
    return result;
  }

  downstream.onmessage = (msg) => {

    const send = async (attempt = 0): Promise<void> => {
      if (reconnectInFlight) await reconnectInFlight;
      try {
        await withTimeout(upstream.send(msg), UPSTREAM_SEND_TIMEOUT_MS, 'upstream.send');
      } catch (err) {
        const errMsg = (err as Error).message;
        logErr(`upstream send failed: ${errMsg} — entering self-heal (attempt ${attempt + 1})`);
        const healed = await reconnectUpstream();
        if (healed && attempt < REQUEST_RESEND_MAX_ATTEMPTS) {
          logErr(`self-heal succeeded; re-sending message through rebuilt upstream`);
          return send(attempt + 1);
        }

        logErr(`upstream send still failing after ${attempt + 1} attempts; surfacing error to agent`);
        respondWithError(msg, `bridge could not deliver request after ${attempt + 1} attempts: ${errMsg}`);
      }
    };
    send().catch((err: Error) => logErr(`downstream pump error: ${err.message}`));
  };


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

  downstream.onclose = () => {
    void upstream.close().finally(() => exitWithReason('downstream (agent) closed'));
  };
  downstream.onerror = (err) => logErr(`downstream: ${err.message}`);

  wireUpstream(upstream);

  await upstream.start();
  await downstream.start();

  startParentWatchdog();
  startUpstreamHeartbeat(() => probe(), () => {
    void reconnectUpstream().catch((err: Error) =>
      logErr(`heartbeat-triggered self-heal failed unexpectedly: ${err.message}`),
    );
  }, upstreamSource.heartbeatMs);

  logErr('bridge ready');
}
