/**
 * Tests for the `myco attach` / `myco detach` residency-mapping surface
 * (Task A1) — the caller that makes `attachProject`/`detachProject` reachable.
 *
 * Hermetic isolation mirrors `tests/host/never-materialize.test.ts`: a per-test
 * tmpdir for MYCO_HOME (threaded explicitly via `attachCommand`'s `mycoHome`
 * option, which the never-materialize local-row guard consults — `detachCommand`
 * has no local-row guard to check, so it takes no `mycoHome` option) plus a
 * `MYCO_TEAM_HOME` env override for the machine-global host/attach registry, so
 * the real `~/.myco*` is never touched. A checkout dir carries a committed
 * `.myco/project.toml` whose `project.id` is the routing key the attach mapping
 * records.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { getHost, resolveAttach, upsertHost, type HostRecord } from '@myco/host/registry.js';
import { attachCommand, detachCommand } from '@myco/host/attach-command.js';
import { createFsDrainStore } from '@myco/capture/transcript-drain.js';

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attach-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attach-team-'));
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  process.env.MYCO_TEAM_HOME = teamHome;
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

afterEach(() => {
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = savedTeamHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teamHome, { recursive: true, force: true });
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

/** A checkout dir with a committed `.myco/project.toml` carrying `project.id`
 *  (and, optionally, a Team Host affiliation hint naming a host). */
function makeCheckout(projectId: string, hintHostId?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attach-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  const doc: Record<string, unknown> = { project: { id: projectId, name: 'demo' } };
  if (hintHostId) doc.grove = { remote: { provider: 'team-host', remote_id: hintHostId } };
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify(doc), 'utf-8');
  clearProjectManifestCache();
  return root;
}

describe('attach/detach command', () => {
  test('attach records the ref (project id from the manifest, grove from the flag)', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const groveId = createGroveId();
    const root = makeCheckout(projectId);

    const result = attachCommand({ projectPath: root, hostId: host.host_id, groveId, mycoHome: home });

    expect(result.alreadyAttached).toBe(false);
    expect(result.projectId).toBe(projectId);
    expect(result.groveId).toBe(groveId);
    expect(result.hostId).toBe(host.host_id);

    const resolved = resolveAttach(projectId);
    expect(resolved?.host.host_id).toBe(host.host_id);
    expect(resolved?.ref).toEqual({ grove_id: groveId, project_id: projectId, root: path.resolve(root) });
  });

  test('attach accepts an explicit --project-id override', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const groveId = createGroveId();
    // Checkout manifest carries a DIFFERENT id; the override wins.
    const root = makeCheckout(createProjectId());

    attachCommand({ projectPath: root, hostId: host.host_id, groveId, projectId, mycoHome: home });

    expect(resolveAttach(projectId)?.host.host_id).toBe(host.host_id);
  });

  test('attach falls back to the host named by the project.toml Team Host hint', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const groveId = createGroveId();
    const root = makeCheckout(projectId, host.host_id);

    // No --host: resolved from the committed affiliation hint.
    const result = attachCommand({ projectPath: root, groveId, mycoHome: home });

    expect(result.hostId).toBe(host.host_id);
    expect(resolveAttach(projectId)?.host.host_id).toBe(host.host_id);
  });

  test('detach clears the ref; resolveAttach then misses', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachCommand({ projectPath: root, hostId: host.host_id, groveId: createGroveId(), mycoHome: home });
    expect(resolveAttach(projectId)).not.toBeNull();

    const result = detachCommand({ projectPath: root });

    expect(result.detachedFromHostId).toBe(host.host_id);
    expect(resolveAttach(projectId)).toBeNull();
    expect(getHost(host.host_id)?.projects).toEqual([]);
  });

  test('detach purges the project transcript-drain queue entries for that host (capture-push §5.2)', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachCommand({ projectPath: root, hostId: host.host_id, groveId: createGroveId(), mycoHome: home });

    // Seed a durable drain entry for this project on this host (as the drain
    // would after shipping a delta), then assert detach clears it.
    const store = createFsDrainStore();
    store.put({
      host_id: host.host_id,
      session_id: 'sess-detach',
      transcript_id: 'tx_00000000000000000000000000000001',
      project_id: projectId,
      grove_id: createGroveId(),
      transcript_path: '/m/s.jsonl',
      acked_offset: 12,
      updated_at: new Date().toISOString(),
    });
    expect(store.listForHost(host.host_id)).toHaveLength(1);

    detachCommand({ projectPath: root });

    expect(store.listForHost(host.host_id)).toHaveLength(0);
  });

  test('re-attach to the same host converges (idempotent, single ref)', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const groveId = createGroveId();
    const root = makeCheckout(projectId);

    attachCommand({ projectPath: root, hostId: host.host_id, groveId, mycoHome: home });
    const second = attachCommand({ projectPath: root, hostId: host.host_id, groveId, mycoHome: home });

    expect(second.alreadyAttached).toBe(true);
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('attach maps ProjectRegisteredLocallyError to a migration-needed (A2) message', () => {
    const grove = createGrove('Default', home);
    const projectId = createProjectId();
    // A local Grove registry row for the project — the never-materialize guard.
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'local',
      projectRoot: path.join(home, 'local-checkout'),
    }, home);

    const host = makeHost();
    upsertHost(host);
    const root = makeCheckout(projectId);

    expect(() => attachCommand({ projectPath: root, hostId: host.host_id, groveId: createGroveId(), mycoHome: home }))
      .toThrow(/still has local Grove data.*task A2/s);
    // The guard wrote nothing.
    expect(resolveAttach(projectId)).toBeNull();
  });

  test('attach maps ProjectAttachedToOtherHostError to an already-attached message', () => {
    const hostA = makeHost({ label: 'Host A' });
    const hostB = makeHost({ label: 'Host B' });
    upsertHost(hostA);
    upsertHost(hostB);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachCommand({ projectPath: root, hostId: hostA.host_id, groveId: createGroveId(), mycoHome: home });

    expect(() => attachCommand({ projectPath: root, hostId: hostB.host_id, groveId: createGroveId(), mycoHome: home }))
      .toThrow(new RegExp(`already attached to host ${hostA.host_id}`));
    // hostA keeps sole ownership.
    expect(resolveAttach(projectId)?.host.host_id).toBe(hostA.host_id);
    expect(getHost(hostB.host_id)?.projects).toEqual([]);
  });

  test('detach of a non-attached project is a clean no-op', () => {
    const projectId = createProjectId();
    const root = makeCheckout(projectId);

    const result = detachCommand({ projectPath: root });

    expect(result.detachedFromHostId).toBeNull();
    expect(result.projectId).toBe(projectId);
  });

  test('attach without --grove fails with an actionable error', () => {
    const host = makeHost();
    upsertHost(host);
    const root = makeCheckout(createProjectId());

    expect(() => attachCommand({ projectPath: root, hostId: host.host_id, mycoHome: home }))
      .toThrow(/requires --grove/);
  });

  test('attach with a malformed --grove value fails format validation (mirrors --project-id)', () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);

    expect(() => attachCommand({ projectPath: root, hostId: host.host_id, groveId: 'not-a-grove-id', mycoHome: home }))
      .toThrow(/--grove must be a Grove id/);
    // Nothing was recorded — the malformed id never reached the registry write.
    expect(resolveAttach(projectId)).toBeNull();
  });

  test('attach to an unknown (not-joined) host fails with a join hint', () => {
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    const unknownHost = createHostId();

    expect(() => attachCommand({ projectPath: root, hostId: unknownHost, groveId: createGroveId(), mycoHome: home }))
      .toThrow(new RegExp(`Unknown host ${unknownHost}.*myco join`, 's'));
  });

  test('attach with no resolvable project id fails with an actionable error', () => {
    const host = makeHost();
    upsertHost(host);
    // A checkout with no committed manifest and no --project-id override.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attach-noid-'));

    expect(() => attachCommand({ projectPath: root, hostId: host.host_id, groveId: createGroveId(), mycoHome: home }))
      .toThrow(/Could not determine the project id/);
  });
});
