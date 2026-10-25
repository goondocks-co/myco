/** Stdio JSON-RPC pump for the credential's Deployment, with bounded reconnect and parent-death detection. */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { credentialRequiredError } from './credential-refusal.js';
import { DEPLOYMENT_HEARTBEAT_INTERVAL_MS, DEPLOYMENT_SELF_HEAL_MAX_ATTEMPTS, declaredCredentialSource, deploymentTransport, probeDeploymentHealth, resolveDeploymentUpstream, soleDeploymentUpstream } from './deployment-upstream.js';
import { bootstrapClientRoots, refuseClientRoots, type RootsBootstrap } from './client-roots.js';
import type { DeploymentUpstream } from './deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { mcpProjectFolder, mcpUsesClientRoots, mcpHasExplicitRoot } from '@myco/cli/flags.js';
import { readRegistryEntryResult } from '@myco/member/registry.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { memberHomeFor } from '@myco/member/home-for-folder.js';
const STDIO_BRIDGE_TAG = '[myco stdio-bridge]';

/** Parent-death watchdog cadence. */
export const PARENT_WATCHDOG_INTERVAL_MS = 10_000;

/** Consecutive failed health probes that trigger an upstream reconnect. */
export const UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD = 2;

/** Deadline for accepting a forwarded POST; tool responses stream separately. */
export const UPSTREAM_SEND_TIMEOUT_MS = 30_000;

/** Maximum resends of one JSON-RPC message after reconnecting. */
export const REQUEST_RESEND_MAX_ATTEMPTS = 2;

/** Delays between reconnect probes, capped at the last value within the attempt limit. */
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

  validate(): void;

  heartbeatMs: number;

  maxHealAttempts: number;
}

function deploymentUpstreamSource(source: CredentialSource, clientDestination?: () => DeploymentUpstream): UpstreamSource {
  const cwd = clientDestination ? undefined : mcpProjectFolder(process.argv.slice(2), process.cwd());
  const mycoHome = cwd === undefined ? undefined : memberHomeFor(cwd).home;
  let destination: { projectId?: string; url: string } | undefined;
  const current = () => {
    if (clientDestination) return clientDestination();
    if (cwd === undefined || mycoHome === undefined) throw new Error('The MCP project folder is unavailable');
    if (memberHomeFor(cwd).home !== mycoHome) throw new Error('The project home changed; reconnect the MCP server before calling tools');
    const contextFree = source === 'registry' && !mcpHasExplicitRoot(process.argv)
      && readRegistryEntryResult(resolveMemberProjectRoot(cwd), mycoHome).status === 'missing';
    const upstream = (contextFree ? soleDeploymentUpstream(mycoHome) : null) ?? resolveDeploymentUpstream(source, { cwd, mycoHome, env: process.env, invokedBy: 'mcp',
      missingMembershipMessage: root => `Myco tools need a connected project folder; ${root} has no connection. Run \`myco member join\` from this project, then reconnect Myco tools.` });
    if (!upstream) return null;
    const selected = { projectId: upstream.projectId, url: upstream.serverUrl };
    if (destination !== undefined && (destination.projectId !== selected.projectId || destination.url !== selected.url)) {
      throw new Error('The project connection changed; reconnect the MCP server before calling tools');
    }
    destination = selected;
    return upstream;
  };
  const resolve = (): Upstream | null => {
    const upstream = current();
    if (upstream === null) return null;
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
    validate() {
      if (current() === null) throw new Error('The project membership is unavailable; reconnect the MCP server after restoring it');
    },
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
    logErr(credentialRequiredError('mcp').message);
    process.exit(1);
  }
  const downstream = new StdioServerTransport();
  const clientRoots = source === 'registry' && mcpUsesClientRoots(process.argv);
  if (clientRoots && mcpHasExplicitRoot(process.argv)) throw new Error('Choose either client roots or an explicit project folder');
  if (clientRoots) startParentWatchdog();
  let bootstrap: RootsBootstrap | undefined;
  try {
    bootstrap = clientRoots ? await bootstrapClientRoots(downstream) : undefined;
    await runBridge(source, downstream, bootstrap);
  } catch (error) {
    if (!clientRoots) throw error;
    logErr(String(error));
    await (bootstrap ? bootstrap.refuse(error) : refuseClientRoots(downstream, error));
    downstream.onclose = () => exitWithReason('client closed a refused roots connection', 1);
    downstream.onerror = error => logErr(error.message);
  }
}

async function runBridge(source: CredentialSource, downstream: StdioServerTransport, bootstrap?: RootsBootstrap): Promise<void> {
  const upstreamSource = deploymentUpstreamSource(source, bootstrap?.destination);
  const initial = await upstreamSource.first();
  if (!initial) {
    if (bootstrap) throw new Error('The selected Deployment is unavailable; reconnect Myco tools after restoring it');
    logErr(`${upstreamSource.describe}: no upstream to bridge stdio MCP to`);
    process.exit(1);
  }

  logErr(`bridge starting (pid=${process.pid}, ppid=${process.ppid}, upstream=${initial.label})`);

  let upstream = initial.transport;

  let probe = initial.probe;
  let contextInvalidated = false;
  let initialization: { resolve: () => void; reject: (error: Error) => void } | undefined;

  let reconnectInFlight: Promise<boolean> | null = null;

  function wireUpstream(t: StreamableHTTPClientTransport): void {
    t.onmessage = (msg) => {
      if (contextInvalidated) return;
      if (initialization && !('method' in msg) && msg.id === bootstrap?.initialize.id) {
        const pending = initialization;
        initialization = undefined;
        if ('error' in msg) pending.reject(new Error(msg.error.message));
        else pending.resolve();
        return;
      }
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

  async function primeUpstream(t: StreamableHTTPClientTransport, context: RootsBootstrap | undefined): Promise<void> {
    if (!context) return;
    upstreamSource.validate();
    const ready = new Promise<void>((resolve, reject) => { initialization = { resolve, reject }; });
    try {
      await withTimeout((async () => {
        await t.send(context.initialize);
        await ready;
        await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      })(), UPSTREAM_SEND_TIMEOUT_MS, 'upstream initialization');
    } finally { initialization = undefined; }
  }

  async function reconnectUpstream(): Promise<boolean> {
    if (contextInvalidated) return false;
    if (reconnectInFlight) return reconnectInFlight;
    reconnectInFlight = (async () => {
      logErr('self-heal: probing Deployment and rebuilding upstream');
      for (let attempt = 0; ; attempt++) {
        if (attempt >= upstreamSource.maxHealAttempts) {
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

        try { upstreamSource.validate(); }
        catch (error) { await rebuilt.transport.close(); throw error; }
        const old = upstream;
        old.onclose = undefined;
        old.onerror = undefined;
        old.onmessage = undefined;
        try { await old.close(); } catch (err) {
          logErr(`self-heal: old upstream close errored (ignored): ${(err as Error).message}`);
        }
        try { upstreamSource.validate(); }
        catch (error) { await rebuilt.transport.close(); throw error; }
        upstream = rebuilt.transport;
        probe = rebuilt.probe;
        wireUpstream(upstream);
        try {
          await upstream.start();
          await primeUpstream(upstream, bootstrap);
          logErr(`self-heal: upstream rebuilt (${rebuilt.label}) after ${attempt + 1} attempts`);
          return true;
        } catch (err) {
          logErr(`self-heal: new upstream start() failed: ${(err as Error).message} — continuing to retry`);
        }
      }
    })();
    try { return await reconnectInFlight; }
    finally { reconnectInFlight = null; }
  }

  const pump: NonNullable<StdioServerTransport['onmessage']> = (msg) => {
    if (bootstrap && 'method' in msg && msg.method === 'notifications/roots/list_changed') {
      contextInvalidated = true;
      bootstrap.invalidate();
      upstream.onclose = undefined;
      void upstream.close().catch((error: Error) => logErr(error.message));
      return;
    }
    const send = async (attempt = 0): Promise<void> => {
      try {
        if (contextInvalidated) throw new Error('Client roots changed; reconnect Myco tools');
        upstreamSource.validate();
      }
      catch (error) {
        respondWithError(msg, error instanceof Error ? error.message : String(error));
        return;
      }
      if (reconnectInFlight) await reconnectInFlight;
      try {
        if (contextInvalidated) throw new Error('Client roots changed; reconnect Myco tools');
        upstreamSource.validate();
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
    send().catch((err: Error) => respondWithError(msg, err.message));
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

  try {
    await upstream.start();
    await primeUpstream(upstream, bootstrap);
    if (bootstrap) bootstrap.release(pump);
    else {
      downstream.onmessage = pump;
      await downstream.start();
    }
  } catch (error) {
    contextInvalidated = true;
    upstream.onclose = undefined;
    await upstream.close();
    throw error;
  }

  if (!bootstrap) startParentWatchdog();
  startUpstreamHeartbeat(() => contextInvalidated ? Promise.resolve(true) : probe(), () => {
    void reconnectUpstream().catch((err: Error) =>
      logErr(`heartbeat-triggered self-heal failed unexpectedly: ${err.message}`),
    );
  }, upstreamSource.heartbeatMs);

  logErr('bridge ready');
}
