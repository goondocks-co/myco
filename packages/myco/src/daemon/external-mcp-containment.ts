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
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  atomicWriteFileSync,
  durableRemovePathSync,
} from '@myco/utils/atomic-write.js';

const EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME = 'intent.external-mcp.toml';
const MIN_EXTERNAL_MCP_PORT = 1024;
const MAX_EXTERNAL_MCP_PORT = 65_535;

export type ExternalMcpContainmentOperation = 'retire' | 'disable' | 'shutdown';
export type ExternalMcpContainmentPhase =
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

export function externalMcpContainmentIntentPath(stateDir: string): string {
  return path.join(stateDir, EXTERNAL_MCP_CONTAINMENT_INTENT_FILENAME);
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
      phase !== 'funnel_off_pending'
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
