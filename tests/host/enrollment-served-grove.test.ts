/**
 * Enrollment self-reports the host's served Grove (protocol v2, server-mode
 * design spec §2/§4) and the member persists it on the joined `HostRecord` —
 * Task 4. Covers the full pipeline:
 *
 *   `buildHostEnrollmentPayload` (host side, `daemon/host-serve.ts`)
 *     → `joinHost`'s enrollment parse + `HostRecord` write (member side,
 *       `host/member-overlay.ts`)
 *     → `attachCommand` sourcing the Grove from the persisted record, no
 *       `--grove` flag (`host/attach-command.ts`).
 *
 * The `GET /api/host-membership/status` `attach_grove_mismatch` surface
 * (spec §2 existing-refs mitigation (c)) is covered by
 * `tests/daemon/api/host-membership.test.ts`, which already owns that
 * route's wire-shape assertions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { buildHostEnrollmentPayload, type HostServeRuntime } from '@myco/daemon/host-serve.js';
import {
  joinHost,
  type EnrollmentClient,
  type EnrollmentContext,
  type HostEnrollment,
  type MemberOverlayDeps,
} from '@myco/host/member-overlay.js';
import { getHost, resolveAttach } from '@myco/host/registry.js';
import { attachCommand } from '@myco/host/attach-command.js';
import { membershipErrorCode } from '@myco/host/membership-error.js';
import { TAILSCALE_VERSION, type CommandRunner } from '@myco/host/overlay-binaries.js';
import { FakeServiceManager } from '../helpers/fake-service-manager.js';

// ---------------------------------------------------------------------------
// (a, part 1) Host side: buildHostEnrollmentPayload self-reports served_grove_id.
// ---------------------------------------------------------------------------

describe('buildHostEnrollmentPayload — served_grove_id self-report', () => {
  function runtime(overrides: Partial<HostServeRuntime> = {}): HostServeRuntime {
    return { overlayAddress: '100.64.0.1', bearer: 'the-bearer', ...overrides };
  }

  test('a designated host reports its served_grove_id', () => {
    const groveId = createGroveId();
    const payload = buildHostEnrollmentPayload(
      runtime({ servedGroveId: groveId, hostId: 'host_x', label: 'Mac Studio' }),
      7433,
    );
    expect(payload.served_grove_id).toBe(groveId);
    expect(payload.protocol_version).toBe(HOST_PROTOCOL_VERSION);
  });

  test('an enabled-but-undesignated host reports served_grove_id as null — present, not absent', () => {
    const payload = buildHostEnrollmentPayload(runtime({ servedGroveId: undefined }), 7433);
    expect(payload.served_grove_id).toBeNull();
    expect('served_grove_id' in payload).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Member side: joinHost persistence, host_id reconciliation, attach sourcing.
// ---------------------------------------------------------------------------

function fakeDarwinRunner(state: { joined: boolean }): CommandRunner {
  return {
    async run(command: string, args: string[]) {
      if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
      if (args.length === 1 && args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
      if (args.includes('up')) { state.joined = true; return { stdout: 'Success.', exitCode: 0 }; }
      if (args.includes('ip')) return { stdout: state.joined ? '100.64.0.5\n' : '\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  };
}

/** Builds an `EnrollmentClient` from a raw wire-shaped response. Omitting
 *  `served_grove_id` from `fields` mirrors what a v1 host's JSON actually
 *  contains — the key isn't there at all, not `served_grove_id: undefined`
 *  sent over the wire (which is indistinguishable from omission once
 *  JSON-parsed, but this keeps the fixture honest about which scenario is
 *  under test). */
function fakeEnrollment(fields: {
  host_id: string;
  overlay_address: string;
  bearer: string;
  served_grove_id?: string;
}): EnrollmentClient {
  return {
    async enroll(_ctx: EnrollmentContext): Promise<HostEnrollment> {
      return {
        host_id: fields.host_id,
        label: `host ${fields.host_id}`,
        overlay_address: fields.overlay_address,
        protocol_version: HOST_PROTOCOL_VERSION,
        bearer: fields.bearer,
        served_grove_id: fields.served_grove_id,
        projects: [],
      };
    },
  };
}

describe('joinHost — served_grove_id persistence + host_id reconciliation (server-mode design spec §4)', () => {
  let tmp: string;
  let brewDir: string;
  let savedTeamHome: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enrollment-served-grove-'));
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedHome = process.env.HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    process.env.HOME = tmp; // home-anchored socket path resolves under tmp (hermetic)
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(overrides: Partial<MemberOverlayDeps> = {}): MemberOverlayDeps {
    return {
      platform: 'darwin',
      arch: 'arm64',
      runner: fakeDarwinRunner({ joined: false }),
      serviceManager: new FakeServiceManager(),
      brewBinDirs: [brewDir],
      waitForSocket: async () => true,
      checkHostReachable: async () => true,
      logger: () => {},
      ...overrides,
    };
  }

  test('(a) enrollment self-reports served_grove_id and joinHost persists it on the HostRecord', async () => {
    const hostId = createHostId();
    const groveId = createGroveId();

    await joinHost(
      { hostRef: hostId, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({
        enrollmentClient: fakeEnrollment({
          host_id: hostId, overlay_address: '100.64.0.1:7433', bearer: 'bearer-1', served_grove_id: groveId,
        }),
      }),
    );

    expect(getHost(hostId)?.served_grove_id).toBe(groveId);
  });

  test('(b) attachCommand sources the Grove from the persisted HostRecord — no --grove flag', async () => {
    const hostId = createHostId();
    const groveId = createGroveId();
    await joinHost(
      { hostRef: hostId, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({
        enrollmentClient: fakeEnrollment({
          host_id: hostId, overlay_address: '100.64.0.1:7433', bearer: 'bearer-1', served_grove_id: groveId,
        }),
      }),
    );

    const projectId = createProjectId();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enrollment-served-grove-proj-'));
    try {
      const result = attachCommand({ projectPath: projectRoot, hostId, projectId, mycoHome: tmp });
      expect(result.groveId).toBe(groveId);
      expect(resolveAttach(projectId)?.ref.grove_id).toBe(groveId);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('(c) old-host enrollment (no served_grove_id field at all) → attach refuses host_predates_served_grove with "update the host"', async () => {
    const hostId = createHostId();
    await joinHost(
      { hostRef: hostId, key: 'onetime', serverUrl: 'https://host:8080' },
      // A v1 host's enrollment response never carries the field at all.
      deps({ enrollmentClient: fakeEnrollment({ host_id: hostId, overlay_address: '100.64.0.1:7433', bearer: 'bearer-1' }) }),
    );
    expect(getHost(hostId)?.served_grove_id).toBeUndefined();

    const projectId = createProjectId();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enrollment-served-grove-proj2-'));
    try {
      expect(() => attachCommand({ projectPath: projectRoot, hostId, projectId, mycoHome: tmp }))
        .toThrow(/predates served-grove designation; update the host/);
      try {
        attachCommand({ projectPath: projectRoot, hostId, projectId, mycoHome: tmp });
        throw new Error('expected attachCommand to throw');
      } catch (err) {
        expect(membershipErrorCode(err)).toBe('host_predates_served_grove');
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('(d) host_id mismatch WARNs (join notes + log) but never re-keys — the typed id stays the record key', async () => {
    const typedHostId = createHostId();
    const reportedHostId = createHostId(); // the host self-reports a DIFFERENT id
    const logs: string[] = [];

    const result = await joinHost(
      { hostRef: typedHostId, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({
        enrollmentClient: fakeEnrollment({ host_id: reportedHostId, overlay_address: '100.64.0.1:7433', bearer: 'bearer-1' }),
        logger: (m) => logs.push(m),
      }),
    );

    expect(result.notes.some((n) => n.includes(reportedHostId) && n.includes(typedHostId))).toBe(true);
    expect(logs.some((l) => l.startsWith('WARNING:') && l.includes(reportedHostId) && l.includes(typedHostId))).toBe(true);
    // Never re-keyed: the record lives under the TYPED id; the reported id
    // was never adopted as a registry key.
    expect(getHost(typedHostId)).not.toBeNull();
    expect(getHost(typedHostId)!.host_id).toBe(typedHostId);
    expect(getHost(reportedHostId)).toBeNull();
  });

  test('a converging re-join with no served_grove_id in the new enrollment preserves the previously-learned value', async () => {
    const hostId = createHostId();
    const groveId = createGroveId();
    await joinHost(
      { hostRef: hostId, key: 'onetime', serverUrl: 'https://host:8080' },
      deps({
        enrollmentClient: fakeEnrollment({
          host_id: hostId, overlay_address: '100.64.0.1:7433', bearer: 'bearer-1', served_grove_id: groveId,
        }),
      }),
    );
    expect(getHost(hostId)?.served_grove_id).toBe(groveId);

    // Re-join via the manual bridge (no host metadata — served_grove_id absent).
    await joinHost(
      { hostRef: hostId, key: 'onetime2', serverUrl: 'https://host:8080', overlayAddress: '100.64.0.1:7433', bearer: 'bearer-2' },
      deps(),
    );

    expect(getHost(hostId)?.served_grove_id).toBe(groveId);
  });
});
