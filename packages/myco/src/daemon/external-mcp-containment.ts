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
  loadMachineConfigStrict,
  readExplicitExternalMcpConfigStrict,
  readRecoverableExternalMcpPortStrict,
} from '@myco/config/loader.js';
import { readSecrets } from '@myco/config/secrets.js';
import {
  EXTERNAL_MCP_DEFAULT_PORT,
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

export type ExternalMcpContainmentOperation = 'retire' | 'disable' | 'shutdown';
export type ExternalMcpContainmentPhase =
  | 'port_recovery_pending'
  | 'funnel_off_pending'
  | 'listener_unbind_pending'
  | 'config_disable_pending';

export interface ExternalMcpContainmentState {
  enabled: boolean;
  port: number;
}

export interface ExternalMcpContainmentIntent {
  version: 1;
  operation: ExternalMcpContainmentOperation;
  from: ExternalMcpContainmentState;
  to: ExternalMcpContainmentState & { enabled: false };
  ports: number[];
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
  readonly isBound: boolean;
  readonly port: number;
}

export interface FunnelOffResult {
  ok: boolean;
  detail: string;
}

export type FunnelOffRunner = (port: number) => Promise<FunnelOffResult>;

export interface ExternalMcpContainmentAuthorityOptions {
  mycoHome: string;
  stateDir: string;
  listener: ExternalMcpListenerControl;
  runFunnelOff: FunnelOffRunner;
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

function parseIntent(value: unknown): ExternalMcpContainmentIntent {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version',
    'operation',
    'from',
    'to',
    'ports',
    'phase',
    'requested_at',
  ])) {
    throw new ExternalMcpContainmentError('External MCP containment intent has an invalid shape');
  }

  const operation = value.operation;
  const phase = value.phase;
  const from = parseState(value.from, { disabledOnly: false });
  const to = parseState(value.to, { disabledOnly: true });
  const ports = value.ports;
  const requestedAt = value.requested_at;
  if (
    value.version !== 1
    || (operation !== 'retire' && operation !== 'disable' && operation !== 'shutdown')
    || (
      phase !== 'port_recovery_pending'
      && phase !== 'funnel_off_pending'
      && phase !== 'listener_unbind_pending'
      && phase !== 'config_disable_pending'
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

  return {
    version: 1,
    operation,
    from,
    to: { enabled: false, port: to.port },
    ports: canonicalPorts,
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
  const canonical = parseIntent({
    ...intent,
    ports,
  });
  const intentPath = externalMcpContainmentIntentPath(stateDir);
  assertIntentPathRegularOrMissing(intentPath);
  atomicWriteFileSync(
    intentPath,
    stringify(canonical as unknown as Record<string, unknown>),
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

function funnelOffFailure(port: number, detail: string): Error {
  return new ExternalMcpContainmentError(
    `Tailscale Funnel-off was not confirmed for port ${port}: ${detail}`,
  );
}

async function runFunnelOffBounded(
  runner: FunnelOffRunner,
  port: number,
  timeoutMs: number,
): Promise<FunnelOffResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner(port),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(funnelOffFailure(port, `timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    if (!result
      || typeof result !== 'object'
      || typeof result.ok !== 'boolean'
      || typeof result.detail !== 'string') {
      throw funnelOffFailure(port, 'runner returned an ambiguous result');
    }
    if (!result.ok) throw funnelOffFailure(port, result.detail);
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
  ): Promise<{ enabled: false; port: number; funnel: FunnelOffResult[] }> {
    return await this.containWhile(
      operation,
      async (containment) => containment,
      options,
    );
  }

  async containWhile<T>(
    operation: ExternalMcpContainmentOperation,
    continuation: (
      containment: { enabled: false; port: number; funnel: FunnelOffResult[] },
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

  private async containLocked(
    operation: ExternalMcpContainmentOperation,
    additionalPorts: number[],
  ): Promise<{ enabled: false; port: number; funnel: FunnelOffResult[] }> {
    reconcileDurableRemovalTombstonesSync(
      this.options.stateDir,
      EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME,
    );
    const existingIntent = readExternalMcpContainmentIntent(this.options.stateDir);
    const funnel: FunnelOffResult[] = [];
    const runPorts = async (ports: number[]): Promise<void> => {
      const failures: unknown[] = [];
      for (const port of ports) {
        try {
          funnel.push(await runFunnelOffBounded(
            this.options.runFunnelOff,
            port,
            this.options.funnelOffTimeoutMs,
          ));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'External MCP containment could not confirm Funnel-off on every known port',
        );
      }
    };

    const finishContainment = async (
      activeIntent: ExternalMcpContainmentIntent,
      targetPort: number,
    ): Promise<{ enabled: false; port: number; funnel: FunnelOffResult[] }> => {
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        ...activeIntent,
        phase: 'listener_unbind_pending',
      });
      await this.options.listener.unbind();

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
              ...(this.options.listener.isBound ? [this.options.listener.port] : []),
              ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
            ],
            phase: 'port_recovery_pending',
          });
          const unresolvedIntent = readExternalMcpContainmentIntent(
            this.options.stateDir,
          )!;
          await runPorts(unresolvedIntent.ports);
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
        ports: [
          ...resumableIntent.ports,
          ...additionalPorts,
          ...(this.options.listener.isBound ? [this.options.listener.port] : []),
          ...(recoverableExternalMcp ? [recoverableExternalMcp.port] : []),
          ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
        ],
        phase: 'funnel_off_pending',
      };
      writeExternalMcpContainmentIntent(this.options.stateDir, activeIntent);
      activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      await runPorts(activeIntent.ports);

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
      await runPorts(unconfirmedPorts);
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
        operation,
        from: fallbackExternalMcp,
        to: { enabled: false, port: fallbackExternalMcp.port },
        ports: [
          fallbackExternalMcp.port,
          ...(recoverableExternalMcpPort ? [recoverableExternalMcpPort] : []),
          ...additionalPorts,
          ...(this.options.listener.isBound ? [this.options.listener.port] : []),
        ],
        phase: 'funnel_off_pending',
        requested_at: this.options.now().toISOString(),
      };
      writeExternalMcpContainmentIntent(this.options.stateDir, fallbackIntent);
      const activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
      await runPorts(activeIntent.ports);
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
    const tokenPresent = typeof readSecrets(
      this.options.mycoHome,
    )[HOST_EXTERNAL_MCP_TOKEN_SECRET] === 'string';
    const brownfieldEvidenceWithoutPort = !explicitExternalMcpConfig
      && (
        operation === 'disable'
        || tokenPresent
      );
    if (brownfieldEvidenceWithoutPort) {
      writeExternalMcpContainmentIntent(this.options.stateDir, {
        version: 1,
        operation,
        from: externalMcp,
        to: { enabled: false, port: externalMcp.port },
        ports: [
          externalMcp.port,
          ...additionalPorts,
          ...(this.options.listener.isBound ? [this.options.listener.port] : []),
        ],
        phase: 'port_recovery_pending',
        requested_at: this.options.now().toISOString(),
      });
      const unresolvedIntent = readExternalMcpContainmentIntent(
        this.options.stateDir,
      )!;
      await runPorts(unresolvedIntent.ports);
      throw new ExternalMcpContainmentPortRecoveryError();
    }
    const requiresContainment = operation === 'disable'
      || externalMcp.enabled
      || explicitExternalMcpConfig
      || tokenPresent
      || this.options.listener.isBound
      || additionalPorts.length > 0;
    if (!requiresContainment) {
      return {
        enabled: false,
        port: externalMcp.port,
        funnel: [],
      };
    }

    const baseIntent: ExternalMcpContainmentIntent = {
      version: 1,
      operation,
      from: externalMcp,
      to: { enabled: false, port: externalMcp.port },
      ports: [
        externalMcp.port,
        ...additionalPorts,
        ...(this.options.listener.isBound ? [this.options.listener.port] : []),
      ],
      phase: 'funnel_off_pending',
      requested_at: this.options.now().toISOString(),
    };
    writeExternalMcpContainmentIntent(this.options.stateDir, baseIntent);
    const activeIntent = readExternalMcpContainmentIntent(this.options.stateDir)!;
    await runPorts(activeIntent.ports);
    return await finishContainment(activeIntent, externalMcp.port);
  }
}
