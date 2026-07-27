/**
 * Write admission at the tool-call pivot: a `project_id` pivot must refuse a
 * project whose write lease is held (grove move, residency transition). The
 * pivot re-targets subsequent reads and writes at a project an operation may
 * be actively moving, so a held — or unreadable — lease refuses with the
 * typed `project_lease_held` code; an absent lease admits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCallContext } from '@myco/tools/call-context.js';
import { isToolError } from '@myco/tools/error.js';
import { acquireProjectLease, releaseProjectLease } from '@myco/grove/project-lease.js';
import { createGrove } from '@myco/grove/registry.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const BASE_PROJECT = assertGroveProjectId('proj_' + '1'.repeat(32));
const TARGET_PROJECT = assertGroveProjectId('proj_' + '2'.repeat(32));

function baseContext(mycoHome: string): MycoRequestContext {
  const projectRoot = path.join(mycoHome, 'base-project');
  return {
    projectRoot,
    callerRoot: null,
    projectId: BASE_PROJECT,
    groveId: 'grv_' + '0'.repeat(32),
    machineId: 'test_machine',
    sessionId: null,
    projectVaultDir: path.join(projectRoot, '.myco'),
    databasePath: path.join(mycoHome, 'groves', 'grv', 'myco.db'),
    source: 'explicit',
    tenancySource: 'caller',
  };
}

describe('resolveCallContext — project write lease at the pivot', () => {
  let mycoHome: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pivot-lease-'));
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('refuses a same-Grove project pivot while the target lease is held, admits after release', () => {
    acquireProjectLease(TARGET_PROJECT, 'residency-attach', 'moving to host', null, mycoHome, testPerUserLockNamespace);

    let thrown: unknown;
    try {
      resolveCallContext(baseContext(mycoHome), { projectId: TARGET_PROJECT }, { mycoHome });
    } catch (error) {
      thrown = error;
    }
    expect(isToolError(thrown)).toBe(true);
    if (isToolError(thrown)) {
      expect(thrown.code).toBe('project_lease_held');
      // The refusal still identifies WHICH move, but in user vocabulary:
      // the pivot now shares the front door's copy so one condition cannot
      // carry two different messages. `residency-attach` is a mechanism
      // name and must not reach an agent-facing string.
      expect(thrown.message).toContain('joining a team');
      expect(thrown.message).not.toContain('residency-attach');
    }

    releaseProjectLease(TARGET_PROJECT, 'residency-attach', mycoHome, testPerUserLockNamespace);
    const pivoted = resolveCallContext(baseContext(mycoHome), { projectId: TARGET_PROJECT }, { mycoHome });
    expect(pivoted.projectId).toBe(TARGET_PROJECT);
  });

  it('a released lease record (retained for its generation) admits the pivot', () => {
    acquireProjectLease(TARGET_PROJECT, 'grove-move', 'moving', null, mycoHome, testPerUserLockNamespace);
    releaseProjectLease(TARGET_PROJECT, 'grove-move', mycoHome, testPerUserLockNamespace);

    const pivoted = resolveCallContext(baseContext(mycoHome), { projectId: TARGET_PROJECT }, { mycoHome });
    expect(pivoted.projectId).toBe(TARGET_PROJECT);
  });

  it('an unreadable lease record refuses — a failed read is not an unheld lease', () => {
    const leasePath = path.join(mycoHome, 'leases', `${TARGET_PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    let thrown: unknown;
    try {
      resolveCallContext(baseContext(mycoHome), { projectId: TARGET_PROJECT }, { mycoHome });
    } catch (error) {
      thrown = error;
    }
    expect(isToolError(thrown)).toBe(true);
    if (isToolError(thrown)) expect(thrown.code).toBe('project_lease_held');
  });

  it('no lease at all admits the pivot unchanged', () => {
    const pivoted = resolveCallContext(baseContext(mycoHome), { projectId: TARGET_PROJECT }, { mycoHome });
    expect(pivoted.projectId).toBe(TARGET_PROJECT);
    expect(pivoted.source).toBe('explicit');
  });

  it('a grove_id-only pivot consults the RETAINED base project lease', () => {
    // The pivot keeps baseContext.projectId while re-aiming at another
    // Grove DB — exactly where a grove move is mid-copying that project's
    // rows. The retained project must get the same consult a supplied one
    // does.
    const grove = createGrove('pivot-target', mycoHome);
    acquireProjectLease(BASE_PROJECT, 'grove-move', 'moving this project', null, mycoHome, testPerUserLockNamespace);

    let thrown: unknown;
    try {
      resolveCallContext(baseContext(mycoHome), { groveId: grove.id }, { mycoHome });
    } catch (error) {
      thrown = error;
    }
    expect(isToolError(thrown)).toBe(true);
    if (isToolError(thrown)) expect(thrown.code).toBe('project_lease_held');

    releaseProjectLease(BASE_PROJECT, 'grove-move', mycoHome, testPerUserLockNamespace);
    const pivoted = resolveCallContext(baseContext(mycoHome), { groveId: grove.id }, { mycoHome });
    expect(pivoted.groveId).toBe(grove.id);
    expect(pivoted.projectId).toBe(BASE_PROJECT);
  });

  it('a non-grove-era project_id still passes through untouched (no lease read)', () => {
    const ctx = baseContext(mycoHome);
    const result = resolveCallContext(ctx, { projectId: 'a'.repeat(32) }, { mycoHome });
    expect(result).toBe(ctx);
  });
});
