/**
 * Tests for the machine-global host/attach registry (Team Host member side).
 *
 * `resolveHostsDir` funnels through `resolveTeamsHome`, which reads
 * `MYCO_TEAM_HOME` from process.env (see `grove/paths.ts`) — tests point
 * that at a fresh tmpdir per test so they never touch the developer's real
 * `~/.myco-team`, mirroring the env-override + tmpdir pattern used by
 * `symbionts/installer/project-files.test.ts` and `config/secrets.test.ts`.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { HOST_BEARER_SECRET } from '@myco/constants';
import { createHostId } from '@myco/grove/ids';
import {
  createHostRegistryOperations,
  ProjectAttachedToOtherHostError,
  type HostRecord,
} from '@myco/host/registry';
import { createHostOperationLock } from '@myco/host/operation-lock';
import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import {
  testPerUserLockNamespace,
  testPerUserLocksRoot,
} from '../helpers/per-user-lock-namespace.js';

const {
  abandonHostEnrollment,
  advanceHostEnrollmentPhase,
  markHostEnrollmentTeardownPending,
  attachProject,
  detachProject,
  getHost,
  persistEnrollmentMembership,
  readHostRegistry,
  readHostSecrets,
  recordHostProtocolVersion,
  reserveHostEnrollment,
  retireHostMembership,
  resolveAttach,
  writeHostSecret,
} = createHostRegistryOperations(testPerUserLockNamespace);
const withHostOperationLock = createHostOperationLock(testPerUserLockNamespace);

async function findFreeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    host_url: 'https://host-a.tailnet.ts.net:8443',
    protocol_version: HOST_PROTOCOL_VERSION,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

describe('host registry', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-registry-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('uses explicit namespaces for registry and host-operation locks', async () => {
    expect(readHostRegistry()).toEqual([]);
    const operationLockDir = path.join(testPerUserLocksRoot, 'host-operations');
    await withHostOperationLock(
      createHostId(),
      'join',
      async () => {},
    );

    expect(fs.readdirSync(path.join(testPerUserLocksRoot, 'host-membership')).length)
      .toBeGreaterThan(0);
    expect(fs.readdirSync(operationLockDir).length).toBeGreaterThan(0);
  });

  test('round-trip: fixture seed then read back, with an attached project', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-1', project_id: 'proj-1' };
    writeHostRecordFixture(host);
    attachProject(host.host_id, ref);

    const all = readHostRegistry();
    expect(all).toHaveLength(1);
    expect(all[0].host_id).toBe(host.host_id);
    expect(all[0].label).toBe('Mac Studio');
    expect(all[0].projects).toEqual([ref]);

    expect(getHost(host.host_id)?.host_url).toBe('https://host-a.tailnet.ts.net:8443');
  });

  test('protocol refresh rejects invalid values without corrupting the record and remains monotonic', () => {
    const host = makeHost({ protocol_version: 3 });
    writeHostRecordFixture(host);

    for (const invalid of [
      0,
      -1,
      3.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => recordHostProtocolVersion(host.host_id, invalid))
        .toThrow(/positive safe integer/);
      expect(getHost(host.host_id)?.protocol_version).toBe(3);
    }

    expect(recordHostProtocolVersion(host.host_id, 4)).toBe(4);
    expect(getHost(host.host_id)?.protocol_version).toBe(4);
    expect(recordHostProtocolVersion(host.host_id, 3)).toBe(4);
    expect(getHost(host.host_id)?.protocol_version).toBe(4);
  });

  test('resolveAttach hits the host + ref for an attached project', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-2', project_id: 'proj-2' };
    writeHostRecordFixture(host);
    attachProject(host.host_id, ref);

    const resolved = resolveAttach(ref.project_id);
    expect(resolved).not.toBeNull();
    expect(resolved?.host.host_id).toBe(host.host_id);
    expect(resolved?.ref).toEqual(ref);
  });

  test('resolveAttach misses for a project attached to no host', () => {
    writeHostRecordFixture(makeHost());
    expect(resolveAttach('proj-unattached')).toBeNull();
  });

  test('resolveAttach misses when the registry has no hosts at all', () => {
    expect(resolveAttach('proj-anything')).toBeNull();
  });

  test('detachProject removes the ref; resolveAttach then misses', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-3', project_id: 'proj-3' };
    writeHostRecordFixture(host);
    attachProject(host.host_id, ref);
    expect(resolveAttach(ref.project_id)).not.toBeNull();

    detachProject(host.host_id, ref.project_id);

    expect(resolveAttach(ref.project_id)).toBeNull();
    expect(getHost(host.host_id)?.projects).toEqual([]);
  });

  test('detachProject on an unknown host is a silent no-op', () => {
    expect(() => detachProject(createHostId(), 'proj-nope')).not.toThrow();
  });

  test('attachProject throws for an unknown host', () => {
    expect(() => attachProject(createHostId(), { grove_id: 'grove-4', project_id: 'proj-4' }))
      .toThrow(/Unknown host/);
  });

  test('attachProject is idempotent for an already-attached project (same host)', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-5', project_id: 'proj-5' };
    writeHostRecordFixture(host);
    attachProject(host.host_id, ref);
    expect(() => attachProject(host.host_id, ref)).not.toThrow();
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('re-attach to the same host backfills an absent `root`', () => {
    const host = makeHost({ projects: [{ grove_id: 'grove-7', project_id: 'proj-7' }] });
    writeHostRecordFixture(host);
    expect(resolveAttach('proj-7')?.ref.root).toBeUndefined();

    attachProject(host.host_id, { grove_id: 'grove-7', project_id: 'proj-7', root: '/checkouts/proj-7' });

    const resolved = resolveAttach('proj-7');
    expect(resolved?.ref.root).toBe('/checkouts/proj-7');
    // grove_id is untouched by the backfill — only `root` self-heals.
    expect(resolved?.ref.grove_id).toBe('grove-7');
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('re-attach to the same host refreshes `root` when the checkout has moved', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    attachProject(host.host_id, { grove_id: 'grove-8', project_id: 'proj-8', root: '/old/checkout' });
    expect(resolveAttach('proj-8')?.ref.root).toBe('/old/checkout');

    attachProject(host.host_id, { grove_id: 'grove-8', project_id: 'proj-8', root: '/new/checkout' });

    expect(resolveAttach('proj-8')?.ref.root).toBe('/new/checkout');
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('re-attach with a rootless ref never clobbers a previously recorded `root`', () => {
    // A caller that re-attaches without a `root` (e.g. an older client, or a
    // call site that hasn't been updated to pass one) must not blow away a
    // `root` a prior attach already recorded — the backfill/refresh branch
    // is for BACKFILLING root from undefined, never for erasing it.
    const host = makeHost();
    writeHostRecordFixture(host);
    attachProject(host.host_id, { grove_id: 'grove-10', project_id: 'proj-10', root: '/checkouts/proj-10' });
    expect(resolveAttach('proj-10')?.ref.root).toBe('/checkouts/proj-10');

    attachProject(host.host_id, { grove_id: 'grove-10', project_id: 'proj-10' });

    expect(resolveAttach('proj-10')?.ref.root).toBe('/checkouts/proj-10');
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('re-attach to the same host never refreshes `grove_id` — a Grove change requires an explicit detach first', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    attachProject(host.host_id, { grove_id: 'grove-original', project_id: 'proj-9', root: '/checkouts/proj-9' });

    attachProject(host.host_id, { grove_id: 'grove-different', project_id: 'proj-9', root: '/checkouts/proj-9' });

    expect(resolveAttach('proj-9')?.ref.grove_id).toBe('grove-original');
  });

  test('attachProject throws ProjectAttachedToOtherHostError when the project is already attached to a different host', () => {
    const hostA = makeHost({ label: 'Host A' });
    const hostB = makeHost({ label: 'Host B' });
    const ref = { grove_id: 'grove-6', project_id: 'proj-6' };
    writeHostRecordFixture(hostA);
    writeHostRecordFixture(hostB);
    attachProject(hostA.host_id, ref);

    let caught: unknown;
    try {
      attachProject(hostB.host_id, ref);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProjectAttachedToOtherHostError);
    const err = caught as ProjectAttachedToOtherHostError;
    expect(err.projectId).toBe(ref.project_id);
    expect(err.attemptedHostId).toBe(hostB.host_id);
    expect(err.existingHostId).toBe(hostA.host_id);

    // The write must not have happened — hostB stays unattached, hostA
    // keeps sole ownership, and resolveAttach still resolves to hostA.
    expect(getHost(hostB.host_id)?.projects).toEqual([]);
    expect(getHost(hostA.host_id)?.projects).toEqual([ref]);
    expect(resolveAttach(ref.project_id)?.host.host_id).toBe(hostA.host_id);
  });

  test('round-trip: a ref with `local_grove_id` persists/reads; a ref without it stays absent (not null)', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    const withHome = { grove_id: 'grove-11', project_id: 'proj-11', local_grove_id: 'grove-local-1' };
    const withoutHome = { grove_id: 'grove-12', project_id: 'proj-12' };
    attachProject(host.host_id, withHome);
    attachProject(host.host_id, withoutHome);

    expect(resolveAttach('proj-11')?.ref).toEqual(withHome);
    expect(resolveAttach('proj-12')?.ref).toEqual(withoutHome);
    expect(resolveAttach('proj-12')?.ref.local_grove_id).toBeUndefined();
    expect('local_grove_id' in (resolveAttach('proj-12')?.ref ?? {})).toBe(false);
  });

  test('re-attach backfills `local_grove_id` for a legacy ref (recorded before the field existed) but never clobbers an already-recorded value', () => {
    const host = makeHost({ projects: [{ grove_id: 'grove-13', project_id: 'proj-13' }] });
    writeHostRecordFixture(host);
    expect(resolveAttach('proj-13')?.ref.local_grove_id).toBeUndefined();

    // First re-attach: backfills the absent value.
    attachProject(host.host_id, { grove_id: 'grove-13', project_id: 'proj-13', local_grove_id: 'grove-local-a' });
    expect(resolveAttach('proj-13')?.ref.local_grove_id).toBe('grove-local-a');

    // Second re-attach with a DIFFERENT explicit value: the already-recorded
    // choice is NOT overwritten — local_grove_id is captured once, at first
    // attach (or first backfill), not silently refreshed like `root`.
    attachProject(host.host_id, { grove_id: 'grove-13', project_id: 'proj-13', local_grove_id: 'grove-local-b' });
    expect(resolveAttach('proj-13')?.ref.local_grove_id).toBe('grove-local-a');
  });

  test('leave retirement fences a restored legacy record after deleting its secrets', async () => {
    const proxyPort = await findFreeLoopbackPort();
    const host = makeHost();
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'a-bearer-token');
    const restoredRecord = fs.readFileSync(path.join(tmp, 'hosts', host.host_id, 'host.json'));

    await withHostOperationLock(host.host_id, 'leave', async (lease) => {
      retireHostMembership(host.host_id, lease);
    });

    expect(getHost(host.host_id)).toBeNull();
    expect(readHostSecrets(host.host_id)).toEqual({});

    const restoredDir = path.join(tmp, 'hosts', host.host_id);
    fs.mkdirSync(restoredDir, { recursive: true });
    fs.writeFileSync(path.join(restoredDir, 'host.json'), restoredRecord);
    fs.writeFileSync(
      path.join(restoredDir, 'secrets.env'),
      `${HOST_BEARER_SECRET}=restored-bearer\n`,
      { mode: 0o600 },
    );
    expect(getHost(host.host_id)).toBeNull();
    expect(readHostSecrets(host.host_id)).toEqual({});
  });

  test('leave repairs a malformed generation ledger before retiring the membership', async () => {
    const host = makeHost();
    const reservation = reserveHostEnrollment(host.host_id);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(
      {
        host_id: host.host_id,
        label: host.label,
        host_url: host.host_url,
        protocol_version: host.protocol_version,
        created_at: host.created_at,
      },
      'a-bearer-token',
      reservation,
    );
    const ledgerPath = path.join(tmp, 'host-generations', `${host.host_id}.json`);
    fs.writeFileSync(ledgerPath, '{malformed', { mode: 0o600 });

    await withHostOperationLock(host.host_id, 'leave', async (lease) => {
      retireHostMembership(host.host_id, lease);
    });

    expect(getHost(host.host_id)).toBeNull();
    expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'))).toMatchObject({
      host_id: host.host_id,
      last_allocated_generation: 1,
      retired_through_generation: 1,
    });
  });

  test('readHostRegistry fails closed when a host.json is missing host_id', () => {
    const host = makeHost();
    writeHostRecordFixture(host);

    const corruptDir = path.join(tmp, 'hosts', 'corrupt-missing-host-id');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(
      path.join(corruptDir, 'host.json'),
      JSON.stringify({ label: 'no host_id here', projects: [] }),
    );

    expect(() => readHostRegistry()).toThrow(/host_join_state_corrupt/);
  });

  test('readHostRegistry fails closed when projects is not an array', () => {
    const host = makeHost();
    writeHostRecordFixture(host);

    const corruptDir = path.join(tmp, 'hosts', 'corrupt-projects-shape');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(
      path.join(corruptDir, 'host.json'),
      JSON.stringify({ host_id: 'host_corrupt', label: 'bad shape', projects: 'not-an-array' }),
    );

    expect(() => readHostRegistry()).toThrow(/host_join_state_corrupt/);
  });

  test('bearer round-trips via secrets and never appears in host.json on disk', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    const bearer = 'super-secret-host-bearer-value';
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, bearer);

    expect(readHostSecrets(host.host_id)[HOST_BEARER_SECRET]).toBe(bearer);

    const hostDir = path.join(tmp, 'hosts', host.host_id);
    const rawRegistry = fs.readFileSync(path.join(hostDir, 'host.json'), 'utf-8');
    expect(rawRegistry).not.toContain(bearer);

    const rawSecrets = fs.readFileSync(path.join(hostDir, 'secrets.env'), 'utf-8');
    expect(rawSecrets).toContain(bearer);
  });
});

describe('enrollment teardown (the mark/discard pair PR 3 rebuilds on)', () => {
  test('mark-then-abandon works — the mark exists for exactly this sequence', () => {
    // These two are a PAIR: `markHostEnrollmentTeardownPending` sets a phase
    // whose only purpose is to be discarded by `abandonHostEnrollment`. Making
    // that phase ineligible turned the sequence into a guaranteed throw — inert
    // while nothing calls the reservation API, and therefore exactly the kind of
    // thing found the hard way once enrollment is rebuilt on top of it.
    const host = makeHost();
    const reservation = reserveHostEnrollment(host.host_id);

    markHostEnrollmentTeardownPending(reservation);
    expect(() => abandonHostEnrollment(reservation)).not.toThrow();

    // Discarded: a fresh reserve allocates a NEW generation rather than
    // adopting the abandoned one.
    const next = reserveHostEnrollment(host.host_id);
    expect(next.generation).toBeGreaterThan(reservation.generation);
  });

  test('a STAGED credential is never discarded — it may already be committed', () => {
    const host = makeHost();
    const reservation = reserveHostEnrollment(host.host_id);
    const staged = advanceHostEnrollmentPhase(reservation, 'credential_staged');

    expect(() => abandonHostEnrollment(staged)).toThrow();
  });
});
