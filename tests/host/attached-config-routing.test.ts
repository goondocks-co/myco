/**
 * Team Host — the config-carve routing refinement (Task 1.5 over Task 1.2).
 *
 * Covers `classifyRoute`'s new `config_carve` decision for an attached project's
 * per-tier config routes, and the `groveTierWriteRefusal` gate that refines the
 * previously-coarse `PUT /api/config/scoped` whole-route lock into a per-leaf
 * decision (routing-layer §6.2/§6.3).
 *
 * Hermetic: `MYCO_TEAM_HOME` points at a fresh tmpdir so the attach registry is
 * empty unless a test seeds it (the same override the registry/routing tests use).
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_BEARER_SECRET } from '@myco/constants';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
  type GroveProjectId,
} from '@myco/grove/ids';
import { writeHostSecret, type HostRecord } from '@myco/host/registry';
import { classifyRoute, classifyRouteStamp, groveTierWriteRefusal } from '@myco/host/routing';

function seedAttached(): { projectId: GroveProjectId; groveId: string; host: HostRecord } {
  const groveId = createGroveId();
  const projectId = assertGroveProjectId(createProjectId());
  const host: HostRecord = {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [{ grove_id: groveId, project_id: projectId }],
  };
  writeHostRecordFixture(host);
  return { projectId, groveId, host };
}

describe('config-carve classification', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-carve-routing-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('config read + scoped write routes stamp config-carve', () => {
    for (const [method, pathname] of [
      ['GET', '/api/config'],
      ['GET', '/api/config/merged'],
      ['GET', '/api/config/local'],
      ['PUT', '/api/config/scoped'],
    ] as const) {
      expect(classifyRouteStamp(method, pathname).stamp).toBe('config-carve');
    }
  });

  test('grove-config write stays config-lock (host-authoritative, whole-route)', () => {
    expect(classifyRouteStamp('PUT', '/api/grove-config').stamp).toBe('config-lock');
  });

  test('attached + config read → config_carve carrying the host target', () => {
    const { projectId, groveId, host } = seedAttached();
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer-xyz');
    const decision = classifyRoute({ method: 'GET', pathname: '/api/config/merged', projectId });
    expect(decision.kind).toBe('config_carve');
    if (decision.kind !== 'config_carve') throw new Error('expected config_carve');
    expect(decision.target.groveId).toBe(groveId);
    expect(decision.target.host.host_id).toBe(host.host_id);
    expect(decision.target.bearer).toBe('host-bearer-xyz');
  });

  test('attached + scoped write → config_carve (NOT the coarse whole-route lock)', () => {
    const { projectId } = seedAttached();
    expect(classifyRoute({ method: 'PUT', pathname: '/api/config/scoped', projectId }).kind).toBe('config_carve');
  });

  test('NON-attached config routes short-circuit to plain local', () => {
    const projectId = assertGroveProjectId(createProjectId());
    for (const [method, pathname] of [
      ['GET', '/api/config/merged'],
      ['PUT', '/api/config/scoped'],
    ] as const) {
      expect(classifyRoute({ method, pathname, projectId }).kind).toBe('local');
    }
  });
});

describe('groveTierWriteRefusal — the scoped-write grove-leaf gate', () => {
  test('a grove-homed leaf (personal override of a shared capability) is refused', () => {
    const refusal = groveTierWriteRefusal(['skills.confidence_threshold']);
    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe('config_host_authoritative');
    expect(refusal?.status).toBe(409);
  });

  test('machine/project/personal-homed leaves proceed locally (no refusal)', () => {
    expect(groveTierWriteRefusal(['notifications.enabled'])).toBeNull(); // machine-homed
    expect(groveTierWriteRefusal(['cortex.enabled'])).toBeNull();        // project-homed
    expect(groveTierWriteRefusal(['symbionts.claude'])).toBeNull();      // project-homed
  });

  test('a mixed patch with ANY grove-homed leaf is refused', () => {
    expect(groveTierWriteRefusal(['cortex.enabled', 'vault_evolution'])).not.toBeNull();
  });

  test('an unknown path is not treated as grove-homed (the scope gate fails it closed with a 400)', () => {
    expect(groveTierWriteRefusal(['made.up.path'])).toBeNull();
  });

  test('an empty leaf set never refuses', () => {
    expect(groveTierWriteRefusal([])).toBeNull();
  });
});
