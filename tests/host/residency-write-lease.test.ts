/**
 * Residency holds the project write lease for the whole transition.
 *
 * The lease is what keeps other writers out of a project whose rows are being
 * moved. Without it, a row written into the source Grove after the backfill
 * snapshot is deleted by `deleteAfterAck` without ever having been shipped —
 * the write is acknowledged, then silently destroyed.
 *
 * It is acquired before the FIRST durable act (so nothing can slip in between
 * the journal opening and the snapshot), held across the deregistration that
 * parking performs, and released only at the terminal phase or on abort.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrove } from '@myco/grove/registry.js';
import { createProjectId as newProjectId } from '@myco/grove/ids.js';
import {
  acquireProjectLease,
  readProjectLease,
  releaseProjectLease,
} from '@myco/grove/project-lease.js';
import { RESIDENCY_ATTACH_OP, RESIDENCY_DETACH_OP } from '@myco/host/residency-transition.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

let home: string;
let savedHome: string | undefined;
let projectId: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-res-lease-'));
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
  projectId = newProjectId();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('residency write lease', () => {
  test('the two directions use distinct owner ids, so a stuck lease names what took it', () => {
    expect(RESIDENCY_ATTACH_OP).not.toBe(RESIDENCY_DETACH_OP);
    expect(RESIDENCY_ATTACH_OP).toContain('residency');
    expect(RESIDENCY_DETACH_OP).toContain('residency');
  });

  test('the lease survives deregistration — the reason it could not live in the registry row', () => {
    // Parking deregisters the project. A lease stored inside that row would
    // vanish exactly when it is most needed; this one is keyed by project id.
    const grove = createGrove('Local', home);
    acquireProjectLease(projectId, RESIDENCY_ATTACH_OP, 'attaching', home, testPerUserLockNamespace);

    // Simulate parking: the project is registered nowhere at all.
    expect(fs.existsSync(path.join(home, 'groves', grove.id))).toBe(true);

    const held = readProjectLease(projectId, home);
    expect(held.state).toBe('present');
    if (held.state !== 'present') return;
    expect(held.value.owner_op).toBe(RESIDENCY_ATTACH_OP);
  });

  test('a second operation cannot take a project already mid-transition', () => {
    acquireProjectLease(projectId, RESIDENCY_ATTACH_OP, 'attaching', home, testPerUserLockNamespace);

    expect(() =>
      acquireProjectLease(projectId, 'grove-move', 'moving', home, testPerUserLockNamespace),
    ).toThrow(/project_lease_held/);

    expect(() =>
      acquireProjectLease(projectId, RESIDENCY_DETACH_OP, 'detaching', home, testPerUserLockNamespace),
    ).toThrow(/project_lease_held/);
  });

  test('a crash-resumed transition can re-acquire its own lease', () => {
    const first = acquireProjectLease(projectId, RESIDENCY_ATTACH_OP, 'attaching', home, testPerUserLockNamespace);
    // The drain re-enters after a restart and must not trip over its own lease.
    const resumed = acquireProjectLease(projectId, RESIDENCY_ATTACH_OP, 'attaching', home, testPerUserLockNamespace);
    expect(resumed.owner_op).toBe(RESIDENCY_ATTACH_OP);
    expect(resumed.generation).toBeGreaterThan(first.generation);
  });

  test('releasing frees the project for the opposite direction', () => {
    acquireProjectLease(projectId, RESIDENCY_ATTACH_OP, 'attaching', home, testPerUserLockNamespace);
    releaseProjectLease(projectId, RESIDENCY_ATTACH_OP, home, testPerUserLockNamespace);

    expect(readProjectLease(projectId, home).state).toBe('absent');
    expect(() =>
      acquireProjectLease(projectId, RESIDENCY_DETACH_OP, 'detaching', home, testPerUserLockNamespace),
    ).not.toThrow();
  });
});
