/**
 * Write admission for the action-scope endpoint family (embedding actions,
 * database maintenance).
 *
 * These endpoints resolve their scope from the request BODY, so
 * `requestContext.projectId` is absent and the central per-project HTTP write
 * gate in `daemon/server.ts` never fires for them. `runScopedAction` is the
 * one funnel every such endpoint passes through, so admission is consulted
 * there — and these tests assert the `run` callback is never reached, which is
 * what "before any durable act" means for this family.
 *
 * Real file-backed lease store, sandboxed MYCO_HOME, no stubs on the gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScopedAction } from '@myco/daemon/api/scoped-dispatch.js';
import { ActionInflightRegistry } from '@myco/daemon/api/action-inflight.js';
import { acquireProjectLease } from '@myco/grove/project-lease.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import type { RouteRequest } from '@myco/daemon/router.js';

const GROVE = 'grove_' + '3'.repeat(32);
const OTHER_GROVE = 'grove_' + '4'.repeat(32);
const PROJECT = 'proj_' + '5'.repeat(32);

describe('runScopedAction — project write admission', () => {
  let mycoHome: string;
  const prevMycoHome = process.env.MYCO_HOME;
  const prevAuth = process.env.MYCO_DAEMON_AUTH;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scoped-admission-'));
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_DAEMON_AUTH = 'test-token';
  });

  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevMycoHome;
    if (prevAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
    else process.env.MYCO_DAEMON_AUTH = prevAuth;
  });

  function request(body: unknown): RouteRequest {
    return { body, query: {}, params: {}, pathname: '/api/embeddings/rebuild' };
  }

  /** Dispatch, recording whether the action body was ever reached. */
  async function dispatch(body: unknown) {
    let ran = false;
    const response = await runScopedAction(
      'test/action',
      request(body),
      new ActionInflightRegistry(),
      async () => {
        ran = true;
        return [{ ok: true, grove_id: GROVE, grove_slug: 'g' }];
      },
    );
    return { response, ran };
  }

  function holdLease(op = 'residency-detach'): void {
    acquireProjectLease(PROJECT, op, 'leaving the team', mycoHome, testPerUserLockNamespace);
  }

  function tearLeaseRecord(): void {
    const leasePath = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');
  }

  it('admits a project-scoped action when no lease is held (gate is not always-on)', async () => {
    const { response, ran } = await dispatch({ scope: { kind: 'project', grove_id: GROVE, project_id: PROJECT } });

    expect(ran).toBe(true);
    expect(response.status).toBeUndefined();
  });

  it('refuses a project-scoped action while that project\'s lease is held', async () => {
    holdLease();

    const { response, ran } = await dispatch({ scope: { kind: 'project', grove_id: GROVE, project_id: PROJECT } });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
    const body = response.body as { error: { code: string }; paused: { owner_op: string } };
    expect(body.error.code).toBe('project_paused');
    expect(body.paused.owner_op).toBe('residency-detach');
  });

  /**
   * The bug this pins: a `project`-scoped request to a GROVE-WIDE endpoint.
   *
   * `embedding/rebuild` accepts `kind:'project'` and then runs
   * `UPDATE <table> SET embedded = 0` with NO WHERE across six
   * project-scoped tables — so a project-scoped REQUEST performs a
   * Grove-wide WRITE. The gate originally consulted only the project named
   * in the request, so scoping to an unleased project A admitted a write
   * that rewrote leased project B's rows inside its residency push window,
   * where `deleteAfterAck` then deleted them unshipped.
   *
   * `resolveActionScope` defaults to `kind:'project'` when the body omits
   * a scope, so this under-gated arm was the DEFAULT path — the UI's "This
   * project" control and every legacy client.
   *
   * The earlier tests could not catch this: each leased the same project it
   * then scoped to, so "scope project A, lease project B" was untested.
   */
  it('refuses a project-scoped action on a grove-wide endpoint when a DIFFERENT project in the Grove is leased', async () => {
    const OTHER_PROJECT = 'proj_' + '6'.repeat(32);
    holdLease(); // leases PROJECT

    // Scope to a different, unleased project in the same Grove.
    const { response, ran } = await dispatch({
      scope: { kind: 'project', grove_id: GROVE, project_id: OTHER_PROJECT },
    });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });

  it('a genuinely project-narrow endpoint still admits when another project is leased', async () => {
    // The other side of the discrimination: an endpoint that declares its
    // writes really are filtered to scope.project_id must not be blocked by
    // an unrelated project's lease, or every narrow action would stall
    // during any residency transition anywhere.
    const OTHER_PROJECT = 'proj_' + '6'.repeat(32);
    holdLease();

    let ran = false;
    const response = await runScopedAction(
      'test/narrow',
      request({ scope: { kind: 'project', grove_id: GROVE, project_id: OTHER_PROJECT } }),
      new ActionInflightRegistry(),
      async () => { ran = true; return [{ ok: true, grove_id: GROVE, grove_slug: 'g' }]; },
      { dataPlane: 'project-narrow' },
    );

    expect(ran).toBe(true);
    expect(response.status).toBeUndefined();
  });

  it('a project-narrow endpoint still refuses when the scoped project ITSELF is leased', async () => {
    holdLease();

    let ran = false;
    const response = await runScopedAction(
      'test/narrow',
      request({ scope: { kind: 'project', grove_id: GROVE, project_id: PROJECT } }),
      new ActionInflightRegistry(),
      async () => { ran = true; return [{ ok: true, grove_id: GROVE, grove_slug: 'g' }]; },
      { dataPlane: 'project-narrow' },
    );

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });

  it('refuses a grove-scoped action when a leased project sits in that Grove', async () => {
    // The lease store records no Grove for an unregistered project, so
    // grove_id resolves to null — the "registered nowhere" case a
    // mid-transition project is always in.
    holdLease();

    const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: GROVE } });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });

  it('refuses a grove-scoped action for ANY Grove while the project is registered nowhere', async () => {
    // Deliberate: mid-residency-transition the project is deregistered from
    // every Grove, so "which Grove owns it" is unanswerable and the only
    // safe answer is to refuse rather than guess.
    holdLease();

    const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: OTHER_GROVE } });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });

  it('admits a grove-scoped action when no lease is held anywhere', async () => {
    const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: GROVE } });

    expect(ran).toBe(true);
    expect(response.status).toBeUndefined();
  });

  it('refuses an all-groves action on any held lease', async () => {
    holdLease();

    const { response, ran } = await dispatch({
      scope: { kind: 'all-groves' },
      confirmation_token: 'test-token',
    });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });

  it('an unreadable lease record refuses — a torn read is never "unheld"', async () => {
    tearLeaseRecord();

    const { response, ran } = await dispatch({ scope: { kind: 'project', grove_id: GROVE, project_id: PROJECT } });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
    const body = response.body as { paused: { reason: string } };
    expect(body.paused.reason).toContain('unreadable');
  });

  it('an UNREADABLE LEASE DIRECTORY refuses the grove-wide path (fails closed, not open)', async () => {
    // Regression: the listing used to swallow a readdir failure and return
    // [], reporting "nothing is leased" while a transition genuinely held a
    // lease we could not see — the widest-blast-radius arm of this gate
    // failing OPEN under a fault the project arm already failed CLOSED on.
    holdLease();
    const leasesDir = path.join(mycoHome, 'leases');
    fs.chmodSync(leasesDir, 0o000);
    try {
      const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: GROVE } });

      expect(ran).toBe(false);
      expect(response.status).toBe(409);
      const body = response.body as { paused: { reason: string } };
      expect(body.paused.reason).toContain('unreadable');
    } finally {
      fs.chmodSync(leasesDir, 0o700); // so afterEach can remove it
    }
  });

  it('an unreadable lease directory refuses all-groves too', async () => {
    holdLease();
    const leasesDir = path.join(mycoHome, 'leases');
    fs.chmodSync(leasesDir, 0o000);
    try {
      const { response, ran } = await dispatch({
        scope: { kind: 'all-groves' },
        confirmation_token: 'test-token',
      });

      expect(ran).toBe(false);
      expect(response.status).toBe(409);
    } finally {
      fs.chmodSync(leasesDir, 0o700);
    }
  });

  it('an absent lease directory is genuinely "nothing leased" and admits', async () => {
    // The other half of the discrimination: ENOENT must NOT be conflated
    // with an undetermined read, or a fresh install could never run a
    // grove-wide action.
    expect(fs.existsSync(path.join(mycoHome, 'leases'))).toBe(false);

    const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: GROVE } });

    expect(ran).toBe(true);
    expect(response.status).toBeUndefined();
  });

  it('an unreadable lease record also blocks the grove-wide path', async () => {
    // `listProjectLeases` drops unreadable records; the admission-side
    // listing must not, or a torn file would open the grove-wide gate.
    tearLeaseRecord();

    const { response, ran } = await dispatch({ scope: { kind: 'grove', grove_id: GROVE } });

    expect(ran).toBe(false);
    expect(response.status).toBe(409);
  });
});
