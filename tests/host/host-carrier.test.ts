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

/**
 * The `x-myco-host-id` destination carrier (E1 §5.3 rev 6) — what makes a
 * joined host with ZERO attached projects configurable. The three-state
 * `served_grove_id` contract is the load-bearing part: string / explicit
 * null / absent are DIFFERENT states with different remedies, and the wire
 * used to flatten them (`?? null`) so the UI could never render the right
 * copy. The legacy-host fallback exists because refusing pre-designation
 * hosts would REGRESS machines that configure fine today via attach refs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { resolveHostDir } from '@myco/grove/paths.js';
import { HOST_BEARER_SECRET } from '@myco/constants.js';
import { resolveHostCarrierTarget } from '@myco/host/routing.js';
import type { HostRecord } from '@myco/host/registry.js';
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 2,
    served_grove_id: createGroveId(),
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

function seedHost(record: HostRecord, bearer = 'bearer-value'): void {
  writeHostRecordFixture(record);
  fs.writeFileSync(
    path.join(resolveHostDir(record.host_id), 'secrets.env'),
    `${HOST_BEARER_SECRET}=${bearer}\n`,
    'utf-8',
  );
}

describe('resolveHostCarrierTarget', () => {
  let tmp: string;
  let prevTeam: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-carrier-'));
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
  });
  afterEach(() => {
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a designated host resolves to a PROJECT-LESS target on the served grove', () => {
    const host = makeHost();
    seedHost(host);
    const resolved = resolveHostCarrierTarget(host.host_id, testPerUserLockNamespace);
    expect(resolved.kind).toBe('target');
    if (resolved.kind !== 'target') throw new Error('unreachable');
    // projectId is NULL, never fabricated — the host derives its served
    // grove itself, and a made-up id throws UnknownRequestContextError
    // host-side before the handler runs.
    expect(resolved.target.projectId).toBeNull();
    expect(resolved.target.groveId).toBe(host.served_grove_id!);
    expect(resolved.target.host.host_id).toBe(host.host_id);
    expect(resolved.target.bearer).toBe('bearer-value');
  });

  it('ZERO attached projects still resolves — the exact hole the carrier closes', () => {
    const host = makeHost({ projects: [] });
    seedHost(host);
    const resolved = resolveHostCarrierTarget(host.host_id, testPerUserLockNamespace);
    expect(resolved.kind).toBe('target');
  });

  it('a LEGACY host (served_grove_id absent) falls back to an attach ref — refusing it would regress', () => {
    const groveId = createGroveId();
    const host = makeHost({
      served_grove_id: undefined,
      projects: [{ grove_id: groveId, project_id: createProjectId() }],
    });
    seedHost(host);
    const resolved = resolveHostCarrierTarget(host.host_id, testPerUserLockNamespace);
    expect(resolved.kind).toBe('target');
    if (resolved.kind !== 'target') throw new Error('unreachable');
    expect(resolved.target.groveId).toBe(groveId);
  });

  it('a legacy host with NO refs refuses host_predates_served_grove, and the remedy names the OPERATOR', () => {
    const host = makeHost({ served_grove_id: undefined, projects: [] });
    seedHost(host);
    const resolved = resolveHostCarrierTarget(host.host_id, testPerUserLockNamespace);
    expect(resolved.kind).toBe('refusal');
    if (resolved.kind !== 'refusal') throw new Error('unreachable');
    // REUSES the existing code — a second code for one condition is drift.
    expect(resolved.refusal.error).toBe('host_predates_served_grove');
    // Re-joining is NOT member self-service: it needs an operator-minted
    // key, and copy implying otherwise contradicts "nobody SSHes into the box".
    expect(resolved.refusal.message).toContain('minted by the host operator');
  });

  it('explicit null (host serves NO grove) is a DIFFERENT state — re-joining cannot fix it', () => {
    const host = makeHost({ served_grove_id: null });
    seedHost(host);
    const resolved = resolveHostCarrierTarget(host.host_id, testPerUserLockNamespace);
    expect(resolved.kind).toBe('refusal');
    if (resolved.kind !== 'refusal') throw new Error('unreachable');
    expect(resolved.refusal.error).toBe('host_serves_no_grove');
    expect(resolved.refusal.message).toContain('host operator must designate');
    expect(resolved.refusal.message).not.toContain('Re-join this host with');
  });

  it('an unknown host id is a 404, not a silent local fallthrough', () => {
    const resolved = resolveHostCarrierTarget('host_' + 'f'.repeat(32), testPerUserLockNamespace);
    expect(resolved.kind).toBe('refusal');
    if (resolved.kind !== 'refusal') throw new Error('unreachable');
    expect(resolved.refusal.status).toBe(404);
    expect(resolved.refusal.error).toBe('unknown_host');
  });
});
