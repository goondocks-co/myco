/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  disableExternalMcpConfig,
  enableExternalMcpConfig,
  loadMachineConfigStrict,
  readExplicitExternalMcpConfigStrict,
  readRecoverableExternalMcpPortStrict,
} from '@myco/config/loader.js';
import { readSecrets } from '@myco/config/secrets.js';
import {
  EXTERNAL_MCP_DEFAULT_PORT,
  EXTERNAL_MCP_FUNNEL_PORT,
  EXTERNAL_MCP_MOUNT,
  HOST_EXTERNAL_MCP_TOKEN_SECRET,
} from '@myco/constants.js';
import {
  atomicWriteFileSync,
  durableRemovePathSync,
  reconcileDurableRemovalTombstonesSync,
} from '@myco/utils/atomic-write.js';
import {
  LifecycleLock,
  type LockHandle,
} from '@myco/utils/lifecycle-lock.js';
import {
  physicalPathIdentity,
  physicalPathLockIdentities,
} from '@myco/utils/physical-path-identity.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

const EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME = 'intent.external-mcp.toml';
const MIN_EXTERNAL_MCP_PORT = 1024;
const MAX_EXTERNAL_MCP_PORT = 65_535;
const EXTERNAL_MCP_CONTAINMENT_LOCK_RETRIES = 8;
const DEFAULT_FUNNEL_OFF_TIMEOUT_MS = 15_000;
const EXTERNAL_MCP_CONFIG_PATH = 'daemon.external_mcp';
const externalMcpContainmentQueues = new Map<string, Promise<void>>();

/**
 * `reconcile` is the activation-era boot operation: it DECIDES (drive off a
 * leftover intent or incoherent state; leave a coherent explicit activation
 * alone and report it) but never writes an intent naming itself — intents it
 * creates are recorded as `retire` so a pre-activation binary can parse and
 * resume them.
 */
export type ExternalMcpContainmentOperation = 'retire' | 'reconcile' | 'disable' | 'shutdown';
export type ExternalMcpContainmentPhase =
  | 'port_recovery_pending'
  | 'enable_pending'
  | 'funnel_off_pending'
  | 'listener_unbind_pending'
  | 'config_disable_pending';

export interface ExternalMcpContainmentState {
  enabled: boolean;
  port: number;
}

export interface ExternalMcpContainmentIntent {
  version: 1 | 2;
  operation: ExternalMcpContainmentOperation;
  from: ExternalMcpContainmentState;
  /** Always a drive-to-off state: an intent on disk ⇒ drive off. The enable
   *  flow's target rides `enable_target`, never `to`. */
  to: ExternalMcpContainmentState & { enabled: false };
  ports: number[];
  /** Socket paths containment must reconcile. Empty on every v1 intent. */
  sockets: string[];
  /** The socket an in-flight enable intends to expose (`enable_pending`
   *  only). Recovery treats it as one more target to drive off. */
  enable_target?: { kind: 'socket'; path: string };
  phase: ExternalMcpContainmentPhase;
  requested_at: string;
}

export class ExternalMcpContainmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExternalMcpContainmentError';
  }
}

export class ExternalMcpContainmentBusyError extends Error {
  constructor() {
    super('Another external MCP containment operation is already in progress.');
    this.name = 'ExternalMcpContainmentBusyError';
  }
}

export class ExternalMcpContainmentPortRecoveryError extends ExternalMcpContainmentError {
  constructor() {
    super('External MCP port could not be recovered from brownfield state');
    this.name = 'ExternalMcpContainmentPortRecoveryError';
  }
}

export interface ExternalMcpListenerControl {
  unbind(): Promise<void>;
  bind(
    target: { kind: 'socket'; path: string } | { kind: 'loopback'; port: number },
  ): Promise<
    | { ok: true; target: { kind: 'socket'; path: string } | { kind: 'loopback'; port: number } }
    | { ok: false; error: string }
  >;
  readonly isBound: boolean;
  /** The bound local endpoint, or null while unbound. */
  readonly boundTarget:
    | { kind: 'socket'; path: string }
    | { kind: 'loopback'; port: number }
    | null;
}

export interface FunnelOffResult {
  ok: boolean;
  detail: string;
}

/**
 * A local endpoint the public Funnel may proxy to. Ports are the legacy
 * (pre-socket) exposure shape and remain first-class so historical state
 * stays containable; sockets are the activation-era shape.
 *
 * Surface-neutral: the external read-only MCP socket and the Team Host socket
 * are both Funnel targets, activated and torn down by the same runners.
 */
export type FunnelTarget =
  | { kind: 'port'; port: number }
  | { kind: 'socket'; path: string };

export function describeFunnelTarget(target: FunnelTarget): string {
  return target.kind === 'port' ? `local port ${target.port}` : `local socket ${target.path}`;
}

export type FunnelOffRunner = (target: FunnelTarget) => Promise<FunnelOffResult>;

export interface FunnelOnResult {
  ok: boolean;
  detail: string;
  /** The public URL the Funnel serves, derived from the vendor tailnet's
   *  host-port selector — not otherwise knowable. Present when ok. */
  funnelUrl?: string;
}

export type FunnelOnRunner = (
  target: { kind: 'socket'; path: string },
  opts: { mount: string; publicPort: number },
) => Promise<FunnelOnResult>;

export interface ExternalMcpContainmentAuthorityOptions {
  mycoHome: string;
  stateDir: string;
  listener: ExternalMcpListenerControl;
  runFunnelOff: FunnelOffRunner;
  /**
   * Funnel targets this authority must ALSO drive off, beyond the external-MCP
   * listener's own — today, the Team Host socket.
   *
   * Two public surfaces exist now, and containment that saw only one would
   * leave the other published: a machine that stops hosting keeps a live URL
   * fronting a socket nothing binds, and a daemon that shuts down keeps
   * answering (badly) while it is down. Supplied as a callback rather than a
   * static list because the answer changes with host config, and it must
   * return EMPTY on a machine that has no evidence of ever hosting — a
   * non-empty return makes `requiresContainment` true, which is what reaches
   * the vendor `tailscale` CLI. A clean machine must still never spawn it.
   */
  additionalFunnelSockets?: () => string[];
  /** The activation inverse of `runFunnelOff`. Optional: shutdown/termination
   *  authorities never activate. `enable` fails cleanly when absent. */
  runFunnelOn?: FunnelOnRunner;
  lockNamespace?: PerUserLockNamespace;
  funnelOffTimeoutMs?: number;
  now?: () => Date;
}

export function externalMcpContainmentIntentPath(stateDir: string): string {
  return path.join(stateDir, EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME);
}

export function isExternalMcpConfigPath(candidate: string): boolean {
  return candidate === EXTERNAL_MCP_CONFIG_PATH
    || candidate.startsWith(`${EXTERNAL_MCP_CONFIG_PATH}.`)
    || EXTERNAL_MCP_CONFIG_PATH.startsWith(`${candidate}.`);
}

function assertIntentPathRegularOrMissing(intentPath: string): 'regular' | 'missing' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(intentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new ExternalMcpContainmentError(
      `Cannot inspect external MCP containment intent at ${intentPath}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ExternalMcpContainmentError(
      `External MCP containment intent is not a regular file: ${intentPath}`,
    );
  }
  return 'regular';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isExternalMcpPort(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= MIN_EXTERNAL_MCP_PORT
    && Number(value) <= MAX_EXTERNAL_MCP_PORT;
}

function parseState(
  value: unknown,
  options: { disabledOnly: boolean },
): ExternalMcpContainmentState | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['enabled', 'port'])) return undefined;
  if (typeof value.enabled !== 'boolean' || !isExternalMcpPort(value.port)) return undefined;
  if (options.disabledOnly && value.enabled) return undefined;
  return {
    enabled: value.enabled,
    port: value.port,
  };
}

function isSocketPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function parseEnableTarget(value: unknown): { kind: 'socket'; path: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'path'])) return undefined;
  if (value.kind !== 'socket' || !isSocketPath(value.path)) return undefined;
  return { kind: 'socket', path: value.path };
}

function parseIntent(value: unknown): ExternalMcpContainmentIntent {
  const V1_KEYS = ['version', 'operation', 'from', 'to', 'ports', 'phase', 'requested_at'] as const;
  const isV1Shape = isRecord(value) && hasExactKeys(value, V1_KEYS);
  const isV2Shape = isRecord(value) && (
    hasExactKeys(value, [...V1_KEYS, 'sockets'])
    || hasExactKeys(value, [...V1_KEYS, 'sockets', 'enable_target'])
  );
  if (!isV1Shape && !isV2Shape) {
    throw new ExternalMcpContainmentError('External MCP containment intent has an invalid shape');
  }

  const operation = value.operation;
  const phase = value.phase;
  const from = parseState(value.from, { disabledOnly: false });
  const to = parseState(value.to, { disabledOnly: true });
  const ports = value.ports;
  const requestedAt = value.requested_at;
  const expectedVersion = isV1Shape ? 1 : 2;
  if (
    value.version !== expectedVersion
    || (operation !== 'retire' && operation !== 'disable' && operation !== 'shutdown')
    || (
      phase !== 'port_recovery_pending'
      && phase !== 'funnel_off_pending'
      && phase !== 'listener_unbind_pending'
      && phase !== 'config_disable_pending'
      // enable_pending is an activation-era phase; it never appears in a
      // v1 file, so a rolled-back binary never meets it.
      && !(isV2Shape && phase === 'enable_pending')
    )
    || !from
    || !to
    || !Array.isArray(ports)
    || ports.length === 0
    || !ports.every(isExternalMcpPort)
    || typeof requestedAt !== 'string'
    || !Number.isFinite(Date.parse(requestedAt))
  ) {
    throw new ExternalMcpContainmentError('External MCP containment intent has invalid values');
  }

  const canonicalPorts = [...new Set(ports)].sort((a, b) => a - b);
  if (canonicalPorts.length !== ports.length
    || canonicalPorts.some((port, index) => port !== ports[index])
    || !canonicalPorts.includes(from.port)
    || !canonicalPorts.includes(to.port)) {
    throw new ExternalMcpContainmentError('External MCP containment intent ports are not canonical');
  }

  let sockets: string[] = [];
  let enableTarget: { kind: 'socket'; path: string } | undefined;
  if (isV2Shape) {
    const rawSockets = value.sockets;
    if (!Array.isArray(rawSockets) || !rawSockets.every(isSocketPath)) {
      throw new ExternalMcpContainmentError('External MCP containment intent has invalid values');
    }
    const canonicalSockets = [...new Set(rawSockets)].sort();
    if (canonicalSockets.length !== rawSockets.length
      || canonicalSockets.some((socket, index) => socket !== rawSockets[index])) {
      throw new ExternalMcpContainmentError('External MCP containment intent sockets are not canonical');
    }
    sockets = canonicalSockets;
    if ('enable_target' in value) {
      enableTarget = parseEnableTarget(value.enable_target);
      if (!enableTarget) {
        throw new ExternalMcpContainmentError('External MCP containment intent has invalid values');
      }
    }
  }

  return {
    version: expectedVersion,
    operation,
    from,
    to: { enabled: false, port: to.port },
    ports: canonicalPorts,
    sockets,
    ...(enableTarget ? { enable_target: enableTarget } : {}),
    phase,
    requested_at: requestedAt,
  };
}

export function readExternalMcpContainmentIntent(
  stateDir: string,
): ExternalMcpContainmentIntent | undefined {
  const intentPath = externalMcpContainmentIntentPath(stateDir);
  if (assertIntentPathRegularOrMissing(intentPath) === 'missing') return undefined;

  try {
    return parseIntent(parse(fs.readFileSync(intentPath, 'utf-8')));
  } catch (error) {
    if (error instanceof ExternalMcpContainmentError) throw error;
    throw new ExternalMcpContainmentError(
      `Cannot parse external MCP containment intent at ${intentPath}`,
      { cause: error },
    );
  }
}

export function writeExternalMcpContainmentIntent(
  stateDir: string,
  intent: ExternalMcpContainmentIntent,
): void {
  const ports = [...new Set([
    ...intent.ports,
    intent.from.port,
    intent.to.port,
  ])].sort((a, b) => a - b);
  const sockets = [...new Set([
    ...(intent.sockets ?? []),
    ...(intent.enable_target ? [intent.enable_target.path] : []),
  ])].sort();
  // Downgrade-clean serialization: a port-only intent is written as v1 so a
  // rolled-back binary can still parse (and drive off) whatever it finds.
  // v2 exists on disk only when a socket target is actually in play — the
  // one case PR 8's rollback policy already governs.
  const isPortOnly = sockets.length === 0
    && intent.enable_target === undefined
    && intent.phase !== 'enable_pending';
  const serialized = isPortOnly
    ? { version: 1 as const, operation: intent.operation, from: intent.from, to: intent.to, ports, phase: intent.phase, requested_at: intent.requested_at }
    : {
      version: 2 as const,
      operation: intent.operation,
      from: intent.from,
      to: intent.to,
      ports,
      sockets,
      ...(intent.enable_target ? { enable_target: intent.enable_target } : {}),
      phase: intent.phase,
      requested_at: intent.requested_at,
    };
  // parseIntent validates; the SERIALIZED shape is what lands on disk (the
  // in-memory parse result always carries `sockets`, which must not leak
  // into a v1 file).
  parseIntent(serialized);
  const intentPath = externalMcpContainmentIntentPath(stateDir);
  assertIntentPathRegularOrMissing(intentPath);
  atomicWriteFileSync(
    intentPath,
    stringify(serialized as unknown as Record<string, unknown>),
    {
      mode: 0o600,
      durable: true,
    },
  );
}

export function clearExternalMcpContainmentIntent(stateDir: string): void {
  const intentPath = externalMcpContainmentIntentPath(stateDir);
  if (assertIntentPathRegularOrMissing(intentPath) === 'missing') return;
  durableRemovePathSync(intentPath);
}

function externalMcpContainmentLockPaths(
  mycoHome: string,
  lockNamespace: PerUserLockNamespace,
): string[] {
  const lockDir = lockNamespace.resolve('external-mcp-activation');
  return physicalPathLockIdentities(mycoHome)
    .map((identity) => {
      const key = crypto.createHash('sha256')
        .update(`external-mcp-activation\0${identity}`)
        .digest('hex');
      return path.join(lockDir, `${key}.lock`);
    })
    .sort();
}

function releaseContainmentLocks(locks: LockHandle[]): void {
  for (const lock of locks.reverse()) lock.release();
}

async function withContainmentFileLocks<T>(
  mycoHome: string,
  lockNamespace: PerUserLockNamespace,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < EXTERNAL_MCP_CONTAINMENT_LOCK_RETRIES; attempt += 1) {
    const paths = externalMcpContainmentLockPaths(mycoHome, lockNamespace);
    const locks: LockHandle[] = [];
    try {
      for (const lockPath of paths) {
        const result = LifecycleLock.acquire(lockPath, {
          command: 'myco external-mcp containment',
        });
        if (!result.acquired) throw new ExternalMcpContainmentBusyError();
        locks.push(result.lock);
      }
    } catch (error) {
      releaseContainmentLocks(locks);
      throw error;
    }

    const freshPaths = externalMcpContainmentLockPaths(mycoHome, lockNamespace);
    if (freshPaths.length !== paths.length
      || freshPaths.some((lockPath, index) => lockPath !== paths[index])) {
      releaseContainmentLocks(locks);
      continue;
    }

    try {
      return await fn();
    } finally {
      releaseContainmentLocks(locks);
    }
  }
  throw new ExternalMcpContainmentError(
    'External MCP containment lock identity did not stabilize',
  );
}

async function withExternalMcpContainment<T>(
  mycoHome: string,
  lockNamespace: PerUserLockNamespace,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = physicalPathIdentity(mycoHome);
  const previous = externalMcpContainmentQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current, () => current);
  externalMcpContainmentQueues.set(queueKey, tail);
  await previous.catch(() => {});
  try {
    return await withContainmentFileLocks(mycoHome, lockNamespace, fn);
  } finally {
    releaseQueue();
    if (externalMcpContainmentQueues.get(queueKey) === tail) {
      externalMcpContainmentQueues.delete(queueKey);
    }
  }
}

function funnelOffFailure(target: FunnelTarget, detail: string): Error {
  return new ExternalMcpContainmentError(
    `Tailscale Funnel-off was not confirmed for ${describeFunnelTarget(target)}: ${detail}`,
  );
}

async function runFunnelOffBounded(
  runner: FunnelOffRunner,
  target: FunnelTarget,
  timeoutMs: number,
): Promise<FunnelOffResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner(target),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(funnelOffFailure(target, `timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    if (!result
      || typeof result !== 'object'
      || typeof result.ok !== 'boolean'
      || typeof result.detail !== 'string') {
      throw funnelOffFailure(target, 'runner returned an ambiguous result');
    }
    if (!result.ok) throw funnelOffFailure(target, result.detail);
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export class ExternalMcpContainmentAuthority {
  private readonly options: Required<
    Pick<ExternalMcpContainmentAuthorityOptions, 'funnelOffTimeoutMs' | 'now'>
  > & ExternalMcpContainmentAuthorityOptions;

  constructor(options: ExternalMcpContainmentAuthorityOptions) {
    if (!Number.isSafeInteger(options.funnelOffTimeoutMs ?? DEFAULT_FUNNEL_OFF_TIMEOUT_MS)
      || (options.funnelOffTimeoutMs ?? DEFAULT_FUNNEL_OFF_TIMEOUT_MS) <= 0) {
      throw new ExternalMcpContainmentError('Funnel-off timeout must be a positive integer');
    }
    this.options = {
      ...options,
      funnelOffTimeoutMs: options.funnelOffTimeoutMs ?? DEFAULT_FUNNEL_OFF_TIMEOUT_MS,
      now: options.now ?? (() => new Date()),
    };
  }

  async contain(
    operation: ExternalMcpContainmentOperation,
    options: { additionalPorts?: number[] } = {},
  ): Promise<{ enabled: boolean; port: number; funnel: FunnelOffResult[] }> {
    return await this.containWhile(
      operation,
      async (containment) => containment,
      options,
    );
  }

  async containWhile<T>(
    operation: ExternalMcpContainmentOperation,
    continuation: (
      containment: { enabled: boolean; port: number; funnel: FunnelOffResult[] },
    ) => Promise<T>,
    options: { additionalPorts?: number[] } = {},
  ): Promise<T> {
    const lockNamespace = this.options.lockNamespace ?? nativePerUserLockNamespace;
    return await withExternalMcpContainment(
      this.options.mycoHome,
      lockNamespace,
      async () => {
        const containment = await this.containLocked(
          operation,
          options.additionalPorts ?? [],
        );
        return await continuation(containment);
      },
    );
  }

  /** The listener's bound loopback port, if any — legacy port-shaped reconcile input. */
  private listenerPorts(): number[] {
    const bound = this.options.listener.boundTarget;
    return bound?.kind === 'loopback' ? [bound.port] : [];
  }

  /** The listener's bound socket path, if any — socket-shaped reconcile input,
   *  PLUS any other Myco Funnel surface this authority is responsible for. */
  private listenerSockets(): string[] {
    const bound = this.options.listener.boundTarget;
    const own = bound?.kind === 'socket' ? [bound.path] : [];
    return [...new Set([...own, ...this.additionalSockets()])];
  }

  private additionalSockets(): string[] {
    try {
      return this.options.additionalFunnelSockets?.() ?? [];
    } catch {
      // A failure to enumerate the other surface must not wedge external-MCP
      // containment — which is the one that owns this authority's config
      // writes. The team funnel is then left to the next boot's sweep.
      return [];
    }
  }

  /**
   * The containment-locked ACTIVATION flow (spec plan 53c47c9ccb52794d D5).
   * Ordering is load-bearing:
   *   clean-slate drive-off → enable_pending intent → explicit config →
   *   token mint → socket bind → funnel-on → verify → clear intent.
   * Config-before-mint means the boot-breaking brownfield state (token
   * present, no explicit subtree) is unrepresentable; intent-first means any
   * crash resumes to the fail-closed drive-off (`enable_pending` resolves
   * through the ordinary resume path — the recorded operation is `disable`).
   * Every step runs under the SAME lock that serializes socket reclaim.
   */
  async enable(deps: {
    socketPath: string;
    mintToken: () => { value: string; minted: boolean };
  }): Promise<
    | { ok: true; funnelUrl: string | null; minted: boolean; token?: string }
    | { ok: false; error: string }
  > {
    if (process.platform === 'win32') {
      return { ok: false, error: 'External MCP activation is not available on Windows.' };
    }
    const runFunnelOn = this.options.runFunnelOn;
    if (!runFunnelOn) {
      return { ok: false, error: 'External MCP activation is not available through this authority.' };
    }
    const lockNamespace = this.options.lockNamespace ?? nativePerUserLockNamespace;
    return await withExternalMcpContainment(
      this.options.mycoHome,
      lockNamespace,
      async () => {
        // Clean slate: drive any prior exposure (or leftover intent) to
        // verified-off before building up. No-op on a clean machine.
        await this.containLocked('disable', []);

        const config = loadMachineConfigStrict(this.options.mycoHome).daemon.external_mcp;
        writeExternalMcpContainmentIntent(this.options.stateDir, {
          version: 2,
          operation: 'disable',
          from: config,
          to: { enabled: false, port: config.port },
          ports: [config.port],
          sockets: [deps.socketPath],
          enable_target: { kind: 'socket', path: deps.socketPath },
          phase: 'enable_pending',
          requested_at: this.options.now().toISOString(),
        });

        const recover = async (error: string) => {
          try {
            await this.containLocked('disable', []);
          } catch (recoveryError) {
            return {
              ok: false as const,
              error: `${error} (and recovery to off also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`,
            };
          }
          return { ok: false as const, error };
        };

        try {
          enableExternalMcpConfig(this.options.mycoHome, { durable: true });
        } catch (err) {
          return await recover(`could not write activation config: ${err instanceof Error ? err.message : String(err)}`);
        }

        let mint: { value: string; minted: boolean };
        try {
          mint = deps.mintToken();
        } catch (err) {
          return await recover(`could not mint the access token: ${err instanceof Error ? err.message : String(err)}`);
        }

        const bound = await this.options.listener.bind({ kind: 'socket', path: deps.socketPath });
        if (!bound.ok) return await recover(`could not bind the socket listener: ${bound.error}`);

        const funnel = await runFunnelOn(
          { kind: 'socket', path: deps.socketPath },
          { mount: EXTERNAL_MCP_MOUNT, publicPort: EXTERNAL_MCP_FUNNEL_PORT },
        );
        if (!funnel.ok) return await recover(`could not activate the public Funnel: ${funnel.detail}`);

        clearExternalMcpContainmentIntent(this.options.stateDir);
        return {
          ok: true,
          funnelUrl: funnel.funnelUrl ?? null,
          minted: mint.minted,
          // The one-time reveal channel: the raw value is returned ONLY on
          // the minting call — a replayed enable can never read the token.
          ...(mint.minted ? { token: mint.value } : {}),
        };
      },
    );
  }

  private async containLocked(
    operation: ExternalMcpContainmentOperation,
    additionalPorts: number[],
  ): Promise<{ enabled: boolean; port: number; funnel: FunnelOffResult[] }> {
    // Intents are parseable by pre-activation binaries: never record
    // `reconcile` in a file — its fail-closed equivalent is `retire`.
    const intentOperation: 'retire' | 'disable' | 'shutdown' = operation === 'reconcile' ? 'retire' : operation;
    reconcileDurableRemovalTombstonesSync(
      this.options.stateDir,
      EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME,
    );
    const existingIntent = readExternalMcpContainmentIntent(this.options.stateDir);
    const funnel: FunnelOffResult[] = [];
    const runTargets = async (
      ports: number[],
      sockets: string[] = [],
    ): Promise<void> => {
      const targets: FunnelTarget[] = [
        ...ports.map((port) => ({ kind: 'port', port } as const)),
        ...sockets.map((socket) => ({ kind: 'socket', path: socket } as const)),
      ];
      const failures: unknown[] = [];
      for (const target of targets) {
        try {
          funnel.push(await runFunnelOffBounded(
            this.options.runFunnelOff,
            target,
            this.options.funnelOffTimeoutMs,
          ));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'External MCP containment could not confirm Funnel-off on every known target',
        );
      }
    };

    // Quiesce vs disavow: `shutdown` stops SERVING (funnel-off + unbind —
    // nothing will answer the public URL while the daemon is down) but MUST
    // NOT write config; a user's activation survives a daemon restart. Only
    // `retire`/`disable` (and a resumed intent at boot, which arrives as
    // `retire`) disavow the config.
    //
    // EXCEPT: a leftover NON-shutdown intent on disk is a standing drive-off
    // obligation ("an intent on disk ⇒ drive off"), and a shutdown that
    // resumes one must complete the disavow — otherwise a disable that
    // failed mid-funnel-off (or a crashed half-enable) is silently reverted
    // by the next daemon stop, and the following boot re-activates exposure
    // the user turned off. The converse branch (leftover shutdown intent met
    // by boot `retire`) already resolves to disavow via the CURRENT
    // operation.
    const disavowsConfig = operation !== 'shutdown'
      || (existingIntent !== undefined && existingIntent.operation !== 'shutdown');
    const finishContainment = async (
      activeIntent: ExternalMcpContainmentIntent,
      targetPort: number,
    ): Promise<{ enabled: boolean; port: number; funnel: FunnelOffResult[] }> => {
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        ...activeIntent,
        phase: 'listener_unbind_pending',
      });
      await this.options.listener.unbind();

      if (!disavowsConfig) {
        clearExternalMcpContainmentIntent(this.options.stateDir);
        const current = loadMachineConfigStrict(this.options.mycoHome).daemon.external_mcp;
        return {
          enabled: current.enabled,
          port: current.port,
          funnel,
        };
      }

      writeExternalMcpContainmentIntent(this.options.stateDir, {
        ...activeIntent,
        phase: 'config_disable_pending',
      });
      disableExternalMcpConfig(this.options.mycoHome, { durable: true });

      const verified = loadMachineConfigStrict(this.options.mycoHome).daemon.external_mcp;
      if (verified.enabled || verified.port !== targetPort) {
        throw new ExternalMcpContainmentError(
          'External MCP config did not verify as disabled after containment',
        );
      }
      clearExternalMcpContainmentIntent(this.options.stateDir);
      return {
        enabled: false,
        port: verified.port,
        funnel,
      };
    };

    if (existingIntent) {
      let recoverableExternalMcp: ExternalMcpContainmentState | undefined;
      let recoverableExternalMcpPort: number | undefined;
      try {
        recoverableExternalMcp = readExplicitExternalMcpConfigStrict(
          this.options.mycoHome,
        );
      } catch {
        recoverableExternalMcp = undefined;
      }
      try {
        recoverableExternalMcpPort = readRecoverableExternalMcpPortStrict(
          this.options.mycoHome,
        );
      } catch {
        recoverableExternalMcpPort = undefined;
      }
      let resumableIntent = existingIntent;
      if (existingIntent.phase === 'port_recovery_pending') {
        if (!recoverableExternalMcp) {
          writeExternalMcpContainmentIntent(this.options.stateDir, {
            ...existingIntent,
            ports: [
              ...existingIntent.ports,
              ...additionalPorts,
              ...this.listenerPorts(),
              ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
            ],
            phase: 'port_recovery_pending',
          });
          const unresolvedIntent = readExternalMcpContainmentIntent(
            this.options.stateDir,
          )!;
          await runTargets(unresolvedIntent.ports, unresolvedIntent.sockets);
          throw new ExternalMcpContainmentPortRecoveryError();
        }
        writeExternalMcpContainmentIntent(this.options.stateDir, {
          ...existingIntent,
          from: recoverableExternalMcp,
          to: { enabled: false, port: recoverableExternalMcp.port },
          ports: [...existingIntent.ports, recoverableExternalMcp.port],
          phase: 'funnel_off_pending',
        });
        resumableIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      }
      let activeIntent: ExternalMcpContainmentIntent = {
        ...resumableIntent,
        sockets: [...new Set([...resumableIntent.sockets, ...this.listenerSockets()])].sort(),
        ports: [
          ...resumableIntent.ports,
          ...additionalPorts,
          ...this.listenerPorts(),
          ...(recoverableExternalMcp ? [recoverableExternalMcp.port] : []),
          ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
        ],
        phase: 'funnel_off_pending',
      };
      writeExternalMcpContainmentIntent(this.options.stateDir, activeIntent);
      activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      await runTargets(activeIntent.ports, activeIntent.sockets);

      let externalMcp: ExternalMcpContainmentState;
      try {
        externalMcp = loadMachineConfigStrict(this.options.mycoHome).daemon.external_mcp;
      } catch (error) {
        writeExternalMcpContainmentIntent(this.options.stateDir, {
          ...activeIntent,
          phase: 'listener_unbind_pending',
        });
        await this.options.listener.unbind();
        writeExternalMcpContainmentIntent(this.options.stateDir, {
          ...activeIntent,
          phase: 'config_disable_pending',
        });
        throw error;
      }

      const unconfirmedPorts = activeIntent.ports.includes(externalMcp.port)
        ? []
        : [externalMcp.port];
      activeIntent = {
        ...activeIntent,
        to: { enabled: false, port: externalMcp.port },
        ports: [...activeIntent.ports, externalMcp.port],
        phase: 'funnel_off_pending',
      };
      writeExternalMcpContainmentIntent(this.options.stateDir, activeIntent);
      activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      await runTargets(unconfirmedPorts);
      return await finishContainment(activeIntent, externalMcp.port);
    }

    let machineConfig: ReturnType<typeof loadMachineConfigStrict>;
    let explicitExternalMcpConfig: boolean;
    let recoverableExternalMcp: ExternalMcpContainmentState | undefined;
    let recoverableExternalMcpPort: number | undefined;
    try {
      recoverableExternalMcp = readExplicitExternalMcpConfigStrict(
        this.options.mycoHome,
      );
      recoverableExternalMcpPort = recoverableExternalMcp?.port;
      explicitExternalMcpConfig = recoverableExternalMcp !== undefined;
      machineConfig = loadMachineConfigStrict(this.options.mycoHome);
    } catch (error) {
      try {
        recoverableExternalMcpPort = readRecoverableExternalMcpPortStrict(
          this.options.mycoHome,
        );
      } catch {
        recoverableExternalMcpPort = undefined;
      }
      const fallbackExternalMcp = recoverableExternalMcp ?? {
        enabled: false,
        port: EXTERNAL_MCP_DEFAULT_PORT,
      };
      const fallbackIntent: ExternalMcpContainmentIntent = {
        version: 1,
        operation: intentOperation,
        from: fallbackExternalMcp,
        to: { enabled: false, port: fallbackExternalMcp.port },
        ports: [
          fallbackExternalMcp.port,
          ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
          ...additionalPorts,
          ...this.listenerPorts(),
        ],
        sockets: this.listenerSockets(),
        phase: 'funnel_off_pending',
        requested_at: this.options.now().toISOString(),
      };
      writeExternalMcpContainmentIntent(this.options.stateDir, fallbackIntent);
      const activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      await runTargets(activeIntent.ports, activeIntent.sockets);
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        ...activeIntent,
        phase: 'listener_unbind_pending',
      });
      await this.options.listener.unbind();
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        ...activeIntent,
        phase: 'config_disable_pending',
      });
      throw error;
    }

    const externalMcp = machineConfig.daemon.external_mcp;
    // Trim-truthy like every OTHER reader of this secret (the round-2 spec
    // review's latent-inconsistency finding): an empty-string token is not
    // evidence of exposure.
    const storedToken = readSecrets(this.options.mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    const tokenPresent = typeof storedToken === 'string' && storedToken.trim().length > 0;

    // Activation-era boot: a coherent explicit activation (enabled config +
    // token) is INTENDED — leave it alone and report it; the boot re-bind
    // phase (main.ts, same lock) re-establishes the listener and Funnel.
    // Anything less coherent falls through to the fail-closed drive-off.
    //
    // "Leave it alone" is about EXTERNAL MCP's OWN exposure, and this early
    // return once meant the team surface was never looked at on exactly the
    // machine that runs both — a host with external MCP enabled and team-funnel
    // residue kept a stale public URL through every boot, with nothing left
    // that would ever check. The team sockets are therefore retired FIRST and
    // the early return happens after: the two surfaces are independent, so one
    // being intended says nothing about the other. Everything about external
    // MCP below is still skipped.
    if (operation === 'reconcile' && explicitExternalMcpConfig && externalMcp.enabled && tokenPresent) {
      await runTargets([], this.additionalSockets());
      return {
        enabled: true,
        port: externalMcp.port,
        funnel,
      };
    }
    const brownfieldEvidenceWithoutPort = !explicitExternalMcpConfig
      && (
        operation === 'disable'
        || tokenPresent
      );
    if (brownfieldEvidenceWithoutPort) {
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        version: 1,
        operation: intentOperation,
        from: externalMcp,
        to: { enabled: false, port: externalMcp.port },
        ports: [
          externalMcp.port,
          ...additionalPorts,
          ...this.listenerPorts(),
        ],
        sockets: this.listenerSockets(),
        phase: 'port_recovery_pending',
        requested_at: this.options.now().toISOString(),
      });
      const unresolvedIntent = readExternalMcpContainmentIntent(
        this.options.stateDir,
      )!;
      await runTargets(unresolvedIntent.ports, unresolvedIntent.sockets);
      throw new ExternalMcpContainmentPortRecoveryError();
    }
    // The team term [M3]: without it, a machine whose ONLY public surface is
    // Team Host short-circuits out of the sweep entirely and its Funnel is
    // never seen — the gap is invisible precisely because every other term
    // here is about external MCP.
    const requiresContainment = operation === 'disable'
      || externalMcp.enabled
      || explicitExternalMcpConfig
      || tokenPresent
      || this.options.listener.isBound
      || additionalPorts.length > 0
      || this.additionalSockets().length > 0;
    if (!requiresContainment) {
      return {
        enabled: false,
        port: externalMcp.port,
        funnel: [],
      };
    }

    const baseIntent: ExternalMcpContainmentIntent = {
      version: 1,
      operation: intentOperation,
      from: externalMcp,
      to: { enabled: false, port: externalMcp.port },
      ports: [
        externalMcp.port,
        ...additionalPorts,
        ...this.listenerPorts(),
      ],
      sockets: this.listenerSockets(),
      phase: 'funnel_off_pending',
      requested_at: this.options.now().toISOString(),
    };
    writeExternalMcpContainmentIntent(this.options.stateDir, baseIntent);
    const activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
    await runTargets(activeIntent.ports, activeIntent.sockets);
    return await finishContainment(activeIntent, externalMcp.port);
  }
}
