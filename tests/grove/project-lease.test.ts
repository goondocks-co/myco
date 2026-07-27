/**
 * The project write lease: exclusivity, a generation that never restarts, and
 * three-state reads that keep writers out when the lease can't be read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectId } from '@myco/grove/ids.js';
import {
  acquireProjectLease,
  forceReleaseProjectLease,
  listProjectLeases,
  ProjectLeaseHeldError,
  readProjectLease,
  releaseProjectLease,
  resolveLeasesDir,
} from '@myco/grove/project-lease.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

let home: string;
let projectId: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lease-'));
  projectId = createProjectId();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const acquire = (owner: string, reason = 'moving') =>
  acquireProjectLease(projectId, owner, reason, null, home, testPerUserLockNamespace);

describe('project write lease', () => {
  test('an unleased project reads as absent', () => {
    expect(readProjectLease(projectId, home).state).toBe('absent');
  });

  test('acquiring makes the lease readable with its owner and reason', () => {
    acquire('grove-move', 'moving between Groves');
    const read = readProjectLease(projectId, home);
    expect(read.state).toBe('present');
    if (read.state !== 'present') return;
    expect(read.value.owner_op).toBe('grove-move');
    expect(read.value.reason).toBe('moving between Groves');
    expect(read.value.released_at).toBeNull();
  });

  test('a different owner is refused, not allowed to steal the lease', () => {
    acquire('grove-move');
    expect(() => acquire('residency-attach')).toThrow(ProjectLeaseHeldError);

    // The original holder is untouched.
    const read = readProjectLease(projectId, home);
    expect(read.state === 'present' && read.value.owner_op).toBe('grove-move');
  });

  test('re-acquiring as the same owner is idempotent (crash-resume)', () => {
    const first = acquire('grove-move');
    const second = acquire('grove-move');
    expect(second.owner_op).toBe('grove-move');
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  test('release frees the project for a different owner', () => {
    acquire('grove-move');
    releaseProjectLease(projectId, 'grove-move', home, testPerUserLockNamespace);

    expect(readProjectLease(projectId, home).state).toBe('absent');
    expect(() => acquire('residency-attach')).not.toThrow();
  });

  test('a non-holder cannot release someone else\'s lease', () => {
    acquire('grove-move');
    expect(() => releaseProjectLease(projectId, 'residency-attach', home, testPerUserLockNamespace))
      .toThrow(ProjectLeaseHeldError);
    expect(readProjectLease(projectId, home).state).toBe('present');
  });

  test('the generation never restarts across release and re-acquire', () => {
    // This is the property fencing depends on. If the counter restarted, a
    // stale writer admitted under an older, higher generation would compare as
    // NEWER than the live lease and the fence would invert.
    const first = acquire('grove-move');
    releaseProjectLease(projectId, 'grove-move', home, testPerUserLockNamespace);
    const second = acquire('residency-attach');
    releaseProjectLease(projectId, 'residency-attach', home, testPerUserLockNamespace);
    const third = acquire('grove-move');

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(third.generation).toBeGreaterThan(second.generation);
  });

  test('force-release drops any holder but preserves the generation', () => {
    const held = acquire('grove-move');
    expect(forceReleaseProjectLease(projectId, home, testPerUserLockNamespace)).toBe(true);
    expect(readProjectLease(projectId, home).state).toBe('absent');

    const next = acquire('residency-attach');
    expect(next.generation).toBeGreaterThan(held.generation);
  });

  test('force-release on an unheld project reports that it did nothing', () => {
    expect(forceReleaseProjectLease(projectId, home, testPerUserLockNamespace)).toBe(false);
  });

  test('an unreadable lease reads as unknown, never as unheld', () => {
    acquire('grove-move');
    // Corrupt the record. A writer must not be admitted because the gate that
    // would have stopped it could not be parsed.
    fs.writeFileSync(path.join(resolveLeasesDir(home), `${projectId}.json`), '{ not json', 'utf-8');

    const read = readProjectLease(projectId, home);
    expect(read.state).toBe('unknown');
  });

  test('acquiring refuses outright when the existing lease is unreadable', () => {
    acquire('grove-move');
    fs.writeFileSync(path.join(resolveLeasesDir(home), `${projectId}.json`), 'torn', 'utf-8');
    expect(() => acquire('grove-move')).toThrow(/unreadable/);
  });

  test('listProjectLeases reports held leases and omits released ones', () => {
    const other = createProjectId();
    acquire('grove-move');
    acquireProjectLease(other, 'residency-attach', 'detaching', null, home, testPerUserLockNamespace);
    releaseProjectLease(other, 'residency-attach', home, testPerUserLockNamespace);

    const held = listProjectLeases(home);
    expect(held.map((l) => l.project_id)).toEqual([projectId]);
  });

  test('rejects a non-grove-era project id rather than writing a stray path', () => {
    expect(() => acquireProjectLease('../escape', 'grove-move', 'x', null, home, testPerUserLockNamespace))
      .toThrow(/grove project id/);
  });
});
