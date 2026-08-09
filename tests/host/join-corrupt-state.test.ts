/**
 * Join over a corrupt on-disk enrollment state.
 *
 * A pre-1.4.0 Myco that crashed mid-join can leave a retired-phase enrollment
 * intent / malformed generation ledger behind. `reserveHostEnrollment` fails
 * closed on it (`HostJoinStateCorruptError`) BEFORE any network call — correct,
 * but the raw message ("host_join_state_corrupt: host …: generation ledger has
 * an invalid shape") tells the user nothing about the fix. `myco leave <host>`
 * clears the residue; join must say so, with a stable code the dashboard maps
 * to its own copy.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { joinHost } from '@myco/host/member-overlay';
import { membershipErrorCode } from '@myco/host/membership-error';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const HOST_ID = 'hostid-corrupt-1';

describe('joinHost over corrupt enrollment state', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-join-corrupt-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    // A generation ledger that parses as JSON but fails the shape check — the
    // shape a half-written / version-skewed join leaves. reserveHostEnrollment
    // throws HostJoinStateCorruptError the moment it reads this.
    const ledgerDir = path.join(tmp, 'host-generations');
    fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(ledgerDir, `${HOST_ID}.json`),
      JSON.stringify({ schema_version: 999, host_id: HOST_ID, last_allocated_generation: 0, retired_through_generation: 0 }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('surfaces a coded error that names `myco leave`, before any network call', async () => {
    let reached = false;
    const promise = joinHost(
      { hostRef: HOST_ID, key: 'one-time-key', hostUrl: 'https://host-a.tailnet.ts.net:8443' },
      {
        lockNamespace: testPerUserLockNamespace,
        machineId: 'tester_00000000',
        logger: () => {},
        // If the reservation guard were missing, join would reach enrollment.
        enrollmentClient: { enroll: async () => { reached = true; throw new Error('should not enroll'); } },
      },
    );
    await expect(promise).rejects.toThrow(/myco leave/);
    expect(reached).toBe(false);

    const err = await promise.catch((e) => e);
    expect(membershipErrorCode(err)).toBe('host_join_state_corrupt');
    expect((err as Error).message).toContain(HOST_ID);
  });
});
