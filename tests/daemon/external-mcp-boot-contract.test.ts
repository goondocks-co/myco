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

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

test('daemon boot holds external MCP containment through startup handoff', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'packages/myco/src/daemon/main.ts'),
    'utf-8',
  );

  expect(source).toContain(
    "return await externalMcpContainment.containWhile('reconcile', async (externalMcpBootState) => {",
  );
  expect(source).toContain('requireRetiredExternalMcp: true');
  expect(source).toContain('isRetiredExternalMcpDaemon(sibling)');
  expect(source).not.toContain("await externalMcpContainment.contain('retire');");
  expect(source).not.toContain("await externalMcpContainment.contain('reconcile');");

  // Two-phase boot (spec R-B3b): the contain phase DECIDES before any
  // subsystem starts; the RE-BIND runs after the listener exists and before
  // the server starts — all inside the containWhile continuation, so the
  // containment lock serializes the socket reclaim (spec R-M6).
  const containIndex = source.indexOf("containWhile('reconcile'");
  const listenerConstruction = source.indexOf('externalMcpListener = new ExternalMcpListener({');
  const rebindIndex = source.indexOf("const rebind = await externalMcpListener.bind({ kind: 'socket'");
  const serverStart = source.indexOf('await server.start(canonicalPort)');
  expect(containIndex).toBeGreaterThanOrEqual(0);
  expect(listenerConstruction).toBeGreaterThan(containIndex);
  expect(rebindIndex).toBeGreaterThan(listenerConstruction);
  expect(serverStart).toBeGreaterThan(rebindIndex);
});

test('eviction posture predicate derives its accepted set from the exported constant (spec R-Q2)', async () => {
  const evictionSource = fs.readFileSync(
    path.join(process.cwd(), 'packages/myco/src/daemon/eviction.ts'),
    'utf-8',
  );
  // Derived, never literal: the predicate names the constant and no posture
  // string literal of its own.
  expect(evictionSource).toContain('KNOWN_EXTERNAL_MCP_POSTURES');
  const predicate = evictionSource.slice(
    evictionSource.indexOf('export function isRetiredExternalMcpDaemon'),
    evictionSource.indexOf('}', evictionSource.indexOf('export function isRetiredExternalMcpDaemon')),
  );
  expect(predicate).not.toContain("'retired'");
  expect(predicate).not.toContain("'active'");

  const { isRetiredExternalMcpDaemon } = await import('@myco/daemon/eviction.js');
  const heartbeat = (posture: string) => ({ myco: true, pid: 123, external_mcp_activation: posture });
  expect(isRetiredExternalMcpDaemon(heartbeat('retired') as never, 123)).toBe(true);
  expect(isRetiredExternalMcpDaemon(heartbeat('active') as never, 123)).toBe(true);
  expect(isRetiredExternalMcpDaemon(heartbeat('surprise') as never, 123)).toBe(false);
  expect(isRetiredExternalMcpDaemon(heartbeat('retired') as never, 999)).toBe(false);
});

test('every production socket-bind call site sits inside a containment-locked region (spec R-M6)', () => {
  // The probe->unlink stale-socket reclaim is NOT atomic on its own; it is
  // safe only because the socket tag and the containment lock both derive
  // from physicalPathIdentity(mycoHome), so every bind must run under that
  // lock. This gate freezes the set of bind call sites — a new one anywhere
  // in the daemon must be added here WITH its lock argument.
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  // Bare `.bind(` — not the object-literal form — so an aliased call
  // (`const t = {...}; listener.bind(t)`) cannot evade the gate.
  const out = execSync(
    "grep -rn --include='*.ts' -e '\\.bind(' packages/myco/src || true",
    { cwd: process.cwd(), encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean);
  const files = [...new Set(out.map((line) => line.split(':')[0]))].sort();
  expect(files).toEqual([
    // Function.prototype.bind + prose — no listener binds here.
    'packages/myco/src/daemon/reconciliation.ts',
    // enable(): inside withExternalMcpContainment (the authority's own lock).
    'packages/myco/src/daemon/external-mcp-containment.ts',
    // control-closure pass-through + boot re-bind: both inside the
    // containWhile('reconcile') continuation.
    'packages/myco/src/daemon/main.ts',
  ].sort());
});
