/**
 * Write admission for buffer reconciliation, and the contract that makes it
 * safe: DEFER, never DISCARD.
 *
 * A buffer dir IS a project (`<mycoHome>/groves/<groveId>/projects/<projectId>/buffer/`),
 * so admission is resolved once in `groveScopeForDir` and surfaces as the
 * `paused` DirScope variant. The reconciler writes sessions, prompt_batches
 * and activities into the source Grove; during a residency push window those
 * rows are deleted unshipped by `deleteAfterAck`, so admitting a write here
 * is capture loss.
 *
 * The subtle failure this file exists to prevent is the OTHER direction:
 * "skipping" a paused project by deleting or quarantining its buffer would
 * lose the same data by a shorter route. Every test below therefore asserts
 * both halves — nothing was written, AND the buffer is still byte-intact and
 * still replays once the lease releases.
 *
 * Runs against the real file-backed lease store under a sandboxed MYCO_HOME.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { getDatabase } from '@myco/db/client.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { acquireProjectLease, releaseProjectLease } from '@myco/grove/project-lease.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const GROVE = 'grove_' + '1'.repeat(32);
const PROJECT = 'proj_' + '2'.repeat(32);

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('buffer reconciliation — write admission defers, never discards', () => {
  let mycoHome: string;
  let bufferDir: string;
  const prevMycoHome = process.env.MYCO_HOME;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => {
    teardownTestDb();
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevMycoHome;
  });

  beforeEach(() => {
    cleanTestDb();
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reconcile-admission-'));
    process.env.MYCO_HOME = mycoHome;
    // Grove-shaped so `bufferDirIdentity` resolves (groveId, projectId).
    bufferDir = path.join(mycoHome, 'groves', GROVE, 'projects', PROJECT, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  function bufferPathFor(sessionId: string): string {
    return path.join(bufferDir, `${sessionId}.jsonl`);
  }

  function writeBuffer(sessionId: string, lines: Array<Record<string, unknown>>): void {
    fs.writeFileSync(bufferPathFor(sessionId), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function makeReconciler() {
    return createReconciler({
      bufferDirs: () => [bufferDir],
      logger: silentLogger,
      projectRoot: process.cwd(),
      // The buffer dir's Grove resolves to the test DB, so a NON-paused
      // project genuinely reconciles — otherwise these tests would pass
      // vacuously via the 'unavailable' arm.
      resolveGroveDb: () => getDatabase(),
    });
  }

  function holdLease(): void {
    acquireProjectLease(PROJECT, 'residency-detach', 'leaving the team', mycoHome, testPerUserLockNamespace);
  }

  function promptEvent(prompt: string) {
    return { type: 'user_prompt', prompt, origin: 'human', timestamp: '2026-07-26T10:00:00.000Z' };
  }

  it('defers reconciliation while the lease is held — no rows written, buffer untouched', () => {
    const sessionId = 'admission-defer';
    seedSession({ id: sessionId });
    writeBuffer(sessionId, [promptEvent('fix the auth bug')]);
    const before = fs.readFileSync(bufferPathFor(sessionId));

    holdLease();
    makeReconciler().reconcileSession(sessionId);

    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
    expect(fs.readFileSync(bufferPathFor(sessionId))).toEqual(before);
  });

  it('replays the deferred buffer once the lease releases (deferred, not dropped)', () => {
    const sessionId = 'admission-replay';
    seedSession({ id: sessionId });
    writeBuffer(sessionId, [promptEvent('fix the auth bug')]);

    holdLease();
    const reconciler = makeReconciler();
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(0);

    // Same reconciler instance: proves the deferred pass wrote no converged
    // mark. A mark would make this second call a no-op and the events would
    // be lost silently.
    releaseProjectLease(PROJECT, 'residency-detach', mycoHome, testPerUserLockNamespace);
    reconciler.reconcileSession(sessionId);

    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(1);
  });

  it('an unreadable lease record defers too — a torn read is never "unheld"', () => {
    const sessionId = 'admission-torn';
    seedSession({ id: sessionId });
    writeBuffer(sessionId, [promptEvent('fix the auth bug')]);

    const leasePath = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    makeReconciler().reconcileSession(sessionId);

    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
  });

  it('cleanStaleBuffers does not delete a paused project\'s buffer', () => {
    const sessionId = 'admission-clean';
    seedSession({ id: sessionId, status: 'completed' });
    writeBuffer(sessionId, [promptEvent('done')]);
    // Old enough that an admitted cleanup pass would delete it.
    const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    fs.utimesSync(bufferPathFor(sessionId), ancient, ancient);

    holdLease();
    makeReconciler().cleanStaleBuffers();

    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
  });

  it('the quarantine prune is deferred as well — retention never runs on a leased project', () => {
    const sessionId = 'admission-quarantine';
    const quarantineDir = path.join(bufferDir, 'quarantine');
    fs.mkdirSync(quarantineDir, { recursive: true });
    const quarantined = path.join(quarantineDir, `${sessionId}.jsonl`);
    fs.writeFileSync(quarantined, JSON.stringify(promptEvent('old')) + '\n');
    const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(quarantined, ancient, ancient);

    holdLease();
    makeReconciler().cleanStaleBuffers();

    expect(fs.existsSync(quarantined)).toBe(true);
  });

  it('runDrainPass contributes no candidates for a leased project', () => {
    const sessionId = 'admission-drain';
    seedSession({ id: sessionId, status: 'completed' });
    writeBuffer(sessionId, [promptEvent('drain me')]);
    const idle = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(bufferPathFor(sessionId), idle, idle);

    holdLease();
    const summary = makeReconciler().runDrainPass({ groveId: GROVE });

    expect(summary.attempted).toBe(0);
    expect(summary.drained).toBe(0);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
  });

  it('drains normally when no lease is held (the gate is not always-on)', () => {
    const sessionId = 'admission-open';
    seedSession({ id: sessionId, status: 'completed' });
    writeBuffer(sessionId, [promptEvent('drain me')]);
    const idle = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(bufferPathFor(sessionId), idle, idle);

    const summary = makeReconciler().runDrainPass({ groveId: GROVE });

    expect(summary.attempted).toBe(1);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length).toBe(1);
  });
});
