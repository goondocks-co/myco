/**
 * Write admission on the tool surface (write-admission phase 6).
 *
 * Tool calls reach the shared handlers through `/mcp`, a RAW route that
 * `DaemonServer.handleRequest` dispatches and returns from before the
 * central per-project pause gate — so they never cross it, whether they
 * arrive from the CLI, an MCP client, or the overlay. A mutating call into a
 * leased project therefore writes into the source Grove during a residency
 * push, where `deleteAfterAck` deletes it unshipped.
 *
 * The contract these tests pin, in both directions:
 *   - mutating ops REFUSE with the typed `project_lease_held` code;
 *   - read ops are ADMITTED, so an agent mid-transition keeps its context;
 *   - the refusal reaches the caller BEFORE the handler runs (nothing
 *     partially written), which is why each case asserts the handler was
 *     never invoked rather than only inspecting the error;
 *   - an unreadable lease counts as held (G4), and is reported as a
 *     condition that will NOT clear on its own;
 *   - the refusal tells an agent whether keeping its content is worthwhile.
 *
 * Real file-backed lease store under a sandboxed MYCO_HOME; no stubs on the
 * gate itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMycoTools } from '@myco/tools/index.js';
import { isToolError } from '@myco/tools/error.js';
import { acquireProjectLease, releaseProjectLease } from '@myco/grove/project-lease.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveProjectsPath } from '@myco/grove/paths.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { DaemonClient } from '@myco/daemon/client.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const PROJECT = assertGroveProjectId('proj_' + '9'.repeat(32));
const OWNER_OP = 'residency-detach';

describe('tool front door — project write admission', () => {
  let mycoHome: string;
  let vaultDir: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-front-door-'));
    vaultDir = path.join(mycoHome, 'project', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  function context(): MycoRequestContext {
    return {
      projectRoot: path.join(mycoHome, 'project'),
      callerRoot: null,
      projectId: PROJECT,
      groveId: 'grv_' + '0'.repeat(32),
      machineId: 'test_machine',
      sessionId: null,
      projectVaultDir: vaultDir,
      databasePath: ':memory:',
      source: 'explicit',
      tenancySource: 'caller',
    };
  }

  /**
   * Tools wired to an in-memory DB and a client that throws if reached.
   * `resolveDatabase` short-circuits the real open/migrate path, so a call
   * that gets past the gate fails loudly instead of quietly succeeding —
   * which is what lets "the handler never ran" be a real assertion.
   */
  function tools(onHandlerReached: () => void) {
    const client = new Proxy({}, {
      get() {
        onHandlerReached();
        throw new Error('handler reached the daemon client — admission should have refused first');
      },
    }) as DaemonClient;
    return createMycoTools(path.join(mycoHome, 'project'), client, {
      requestContext: context(),
      mycoHome,
      resolveDatabase: () => {
        onHandlerReached();
        throw new Error('database opened — admission should have refused first');
      },
    });
  }

  function holdLease(op = OWNER_OP): void {
    acquireProjectLease(PROJECT, op, 'detaching from a Team Host', null, mycoHome, testPerUserLockNamespace);
  }

  async function callExpectingRefusal(name: string, args: unknown) {
    let reached = false;
    const t = tools(() => { reached = true; });
    let thrown: unknown;
    try {
      await t.callTool(name, args);
    } catch (error) {
      thrown = error;
    }
    return { thrown, reached };
  }

  // --- writes refuse -----------------------------------------------------

  it('refuses myco_spores save while the lease is held, before the handler runs', async () => {
    holdLease();

    const { thrown, reached } = await callExpectingRefusal('myco_spores', {
      op: 'save', content: 'x', type: 'gotcha',
    });

    expect(isToolError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe('project_lease_held');
    expect(reached).toBe(false);
  });

  it('refuses myco_plans save and delete', async () => {
    holdLease();

    for (const args of [{ op: 'save', content: '# p', plan_key: 'k', session_id: 's' }, { op: 'delete', id: 'x' }]) {
      const { thrown, reached } = await callExpectingRefusal('myco_plans', args);
      expect((thrown as { code?: string }).code, `op ${String(args.op)}`).toBe('project_lease_held');
      expect(reached).toBe(false);
    }
  });

  it('refuses every mutating spores op', async () => {
    holdLease();

    for (const op of ['save', 'supersede', 'consolidate', 'obsolete']) {
      const { thrown } = await callExpectingRefusal('myco_spores', { op, content: 'x', type: 'gotcha' });
      expect((thrown as { code?: string }).code, `op ${op}`).toBe('project_lease_held');
    }
  });

  // --- reads are admitted ------------------------------------------------

  it('ADMITS read ops while the lease is held — the agent keeps its context', async () => {
    holdLease();

    // Reaching the handler (and failing there) is the pass condition: it
    // proves admission let the call through rather than refusing it.
    for (const [name, args] of [
      ['myco_search', { query: 'x' }],
      ['myco_plans', { op: 'list' }],
      ['myco_spores', { op: 'list' }],
      ['myco_sessions', { op: 'list' }],
    ] as const) {
      const { thrown, reached } = await callExpectingRefusal(name, args);
      expect(reached, `${name} should have been admitted`).toBe(true);
      expect((thrown as { code?: string }).code, `${name} must not be lease-refused`).not.toBe('project_lease_held');
    }
  });

  it('admits a write once the lease is released (the gate is not always-on)', async () => {
    holdLease();
    releaseProjectLease(PROJECT, OWNER_OP, mycoHome, testPerUserLockNamespace);

    const { thrown, reached } = await callExpectingRefusal('myco_spores', {
      op: 'save', content: 'x', type: 'gotcha',
    });

    expect(reached).toBe(true);
    expect((thrown as { code?: string }).code).not.toBe('project_lease_held');
  });

  it('admits writes when no lease was ever taken', async () => {
    const { thrown, reached } = await callExpectingRefusal('myco_spores', {
      op: 'save', content: 'x', type: 'gotcha',
    });

    expect(reached).toBe(true);
    expect((thrown as { code?: string }).code).not.toBe('project_lease_held');
  });

  // --- G4 ----------------------------------------------------------------

  it('an unreadable lease record refuses a write — a torn read is never "unheld"', async () => {
    const leasePath = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    const { thrown, reached } = await callExpectingRefusal('myco_spores', {
      op: 'save', content: 'x', type: 'gotcha',
    });

    expect((thrown as { code?: string }).code).toBe('project_lease_held');
    expect(reached).toBe(false);
  });

  // --- copy contract -----------------------------------------------------

  it('speaks user vocabulary and names the move, without leaking mechanism names', async () => {
    holdLease('residency-detach');

    const { thrown } = await callExpectingRefusal('myco_spores', { op: 'save', content: 'x', type: 'gotcha' });
    const message = (thrown as { message: string }).message;

    expect(message).toContain('leaving a team');
    expect(message).toContain("can't be changed");
    // The caller must know the write did NOT happen, or it will assume success.
    expect(message).toContain('Nothing was saved');
    // Names the project: the pivot case refuses a project that is NOT the
    // one the agent is working in, where "this project" would be ambiguous.
    expect(message).toContain(PROJECT);
    expect(message).not.toContain('residency-detach');
    expect(message).not.toContain('lease');
  });

  it('marks a held lease retryable so an agent holds its content instead of discarding it', async () => {
    holdLease();

    const { thrown } = await callExpectingRefusal('myco_spores', { op: 'save', content: 'x', type: 'gotcha' });

    expect((thrown as { data: { retryable?: boolean } }).data.retryable).toBe(true);
    expect((thrown as { message: string }).message).toContain('keep this content');
  });

  it('does NOT promise self-resolution on an unreadable record — it will not clear on its own', async () => {
    // A torn lease file is not a move in progress. Borrowing the
    // in-progress copy would send an agent into a blind retry loop against
    // a condition that needs a human, and lose the content each time.
    const leasePath = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    const { thrown } = await callExpectingRefusal('myco_spores', { op: 'save', content: 'x', type: 'gotcha' });
    const message = (thrown as { message: string }).message;

    expect(message).toContain('unreadable');
    expect(message).toContain('needs someone to look at it');
    expect(message).not.toContain('once the move finishes');
    expect((thrown as { data: { retryable?: boolean } }).data.retryable).toBe(false);
  });

  it('names an attach as joining, and a grove move generically', async () => {
    holdLease('residency-attach');
    const attach = await callExpectingRefusal('myco_spores', { op: 'save', content: 'x', type: 'gotcha' });
    expect((attach.thrown as { message: string }).message).toContain('joining a team');

    releaseProjectLease(PROJECT, 'residency-attach', mycoHome, testPerUserLockNamespace);
    // The REAL owner_op a grove move writes is an opaque generated id, not
    // the literal 'grove-move' (that string is its `reason`). Using the
    // literal here would make this pass for the wrong reason and would not
    // exercise the id that exact-matching exists to handle.
    const realMoveOwnerOp = `grove-move-${PROJECT}-${1730000000000}`;
    holdLease(realMoveOwnerOp);
    const move = await callExpectingRefusal('myco_spores', { op: 'save', content: 'x', type: 'gotcha' });
    const moveMessage = (move.thrown as { message: string }).message;
    expect(moveMessage).toContain('being moved');
    // The opaque id must not reach the agent.
    expect(moveMessage).not.toContain(realMoveOwnerOp);
    expect(moveMessage).not.toContain('grove-move');
  });

  it('honors a LEGACY in-row pause with no lease file, as the HTTP gate does', async () => {
    // The previous binary recorded pauses inside the project's projects.toml
    // row rather than as a lease file. `isProjectPaused` still honors that
    // during the upgrade window; reading the lease alone would admit a write
    // here that every other writer-side gate refuses.
    const grove = createGrove('Work', mycoHome);
    registerProjectInGrove(
      grove.id,
      { projectId: PROJECT, projectName: 'work', projectRoot: path.join(mycoHome, 'project') },
      mycoHome,
    );
    // Written as raw TOML on purpose: `pauseProject` now delegates to the
    // lease store, so it can no longer PRODUCE the legacy shape. This is what
    // the previous binary left on disk.
    const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
    fs.appendFileSync(
      projectsPath,
      `\n[projects."${PROJECT}".paused]\nsince = 1730000000\nreason = "grove-move"\nowner_op = "grove-move-${PROJECT}-1"\n`,
      'utf-8',
    );
    // Premise check: the refusal below must come from the TOML, not a lease.
    expect(fs.existsSync(path.join(mycoHome, 'leases', `${PROJECT}.json`))).toBe(false);

    const { thrown, reached } = await callExpectingRefusal('myco_spores', {
      op: 'save', content: 'x', type: 'gotcha',
    });

    expect((thrown as { code?: string }).code).toBe('project_lease_held');
    expect(reached).toBe(false);
  });
});
