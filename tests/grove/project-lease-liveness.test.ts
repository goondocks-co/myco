/**
 * Gate W4 — no lease outlives its operation.
 *
 * The property: a lease is held iff its holder is alive OR its operation is
 * unfinished. Both are facts evaluated when the lease is READ, so an
 * abandoned lease resolves as free the moment anyone asks — with **no
 * sweeper run and no time advanced**. Every case below asserts that
 * explicitly, because "a sweeper eventually fixes it" was the previous
 * answer and is exactly what W4 replaces.
 *
 * The deregistered case is mandatory, not incidental. The mechanism this
 * replaces enumerated `listGroves` → `listRegisteredProjects` to find leases
 * to free, and a project mid-residency-transition is deregistered from every
 * Grove while its lease is held — so the one project that could strand was
 * the one the sweeper could not see. A gate that only exercised registered
 * projects would have passed against the broken implementation. Nothing in
 * this file registers a project anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireProjectLease,
  readProjectLease,
  releaseProjectLease,
  type LeaseEvidence,
} from '@myco/grove/project-lease.js';
import { currentBootId } from '@myco/grove/holder-identity.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const PROJECT = assertGroveProjectId('proj_' + 'd'.repeat(32));
const OWNER = 'residency-detach';

describe('W4 — a lease does not outlive its operation', () => {
  let mycoHome: string;
  let journalPath: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-w4-'));
    journalPath = path.join(mycoHome, 'residency', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  const journalEvidence = (): LeaseEvidence => ({ kind: 'residency-journal', path: journalPath });

  function writeJournal(phase: string): void {
    fs.writeFileSync(journalPath, JSON.stringify({ project_id: PROJECT, phase }), 'utf-8');
  }

  /**
   * Rewrite the on-disk record so its holder is a process that cannot exist:
   * a previous boot. This is the crash — the lease survives, its holder does
   * not — without needing to kill a real process.
   */
  function killHolder(): void {
    const leaseFile = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf-8'));
    // A different boot: on Linux a different UUID, otherwise an epoch far
    // enough back that no tolerance absorbs it. Either way the holder cannot
    // still exist.
    lease.holder = { pid: lease.holder.pid, boot_id: 'boot-that-has-since-ended' };
    fs.writeFileSync(leaseFile, JSON.stringify(lease, null, 2), 'utf-8');
  }

  function hold(evidence: LeaseEvidence | null): void {
    acquireProjectLease(PROJECT, OWNER, 'detaching', evidence, mycoHome, testPerUserLockNamespace);
  }

  const isHeld = () => readProjectLease(PROJECT, mycoHome).state === 'present';

  // --- the live holder ---------------------------------------------------

  it('is held while the holder is alive, whatever the operation says', () => {
    writeJournal('done'); // terminal: only holder-liveness can be holding it
    hold(journalEvidence());

    expect(isHeld()).toBe(true);
  });

  it('is held while the holder is alive and no evidence was declared', () => {
    hold(null);

    expect(isHeld()).toBe(true);
  });

  // --- the crash matrix: dead holder, per phase ---------------------------

  // Every phase a residency transition can crash in. A crash at any
  // non-terminal phase must keep the project blocked, because the transition
  // is resumable and its journal outlives the process by design.
  for (const phase of ['parking', 'pushing', 'pulling', 'applying', 'rehoming']) {
    it(`stays held after a crash at phase "${phase}" — the operation is unfinished`, () => {
      writeJournal(phase);
      hold(journalEvidence());
      killHolder();

      expect(isHeld()).toBe(true);
    });
  }

  it('frees once the crashed transition reaches its terminal phase', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder();
    expect(isHeld()).toBe(true);

    writeJournal('done');

    // No sweeper, no time advanced — the same read now resolves free.
    expect(isHeld()).toBe(false);
  });

  it('frees when the crashed operation left no record at all', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder();

    fs.rmSync(journalPath);

    expect(isHeld()).toBe(false);
  });

  it('frees immediately when a dead holder declared no evidence', () => {
    hold(null);
    killHolder();

    expect(isHeld()).toBe(false);
  });

  // --- fail-closed ---------------------------------------------------------

  it('stays held when the operation record cannot be read (G4)', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder();
    // Unparseable: cannot prove terminal, so it must not free.
    fs.writeFileSync(journalPath, '{ torn', 'utf-8');

    expect(isHeld()).toBe(true);
  });

  it('a move frees its lease by reaching a TERMINAL phase, not by deleting its marker', () => {
    // The marker is never deleted: `grove/move.ts` retains `completed` and
    // `failed` markers on purpose, because findCompletedMarkerForProject
    // reads a completed one back for the idempotent-return path. An earlier
    // version of this rule treated existence as in-flight, which made every
    // grove-move lease permanently held — and an earlier version of THIS
    // test hid that by deleting the marker itself, certifying a lifecycle
    // production does not have.
    const markerPath = path.join(mycoHome, 'migration', 'grove-move-1.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const marker = (phase: string) =>
      fs.writeFileSync(markerPath, JSON.stringify({ project_id: PROJECT, phase }), 'utf-8');

    marker('copying');
    hold({ kind: 'move-marker', path: markerPath });
    killHolder();
    expect(isHeld()).toBe(true);

    marker('completed');
    expect(fs.existsSync(markerPath), 'the marker must survive — the move keeps it').toBe(true);
    expect(isHeld()).toBe(false);
  });

  it('a FAILED move also frees — its marker is terminal and no resume will claim it', () => {
    const markerPath = path.join(mycoHome, 'migration', 'grove-move-2.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ phase: 'failed' }), 'utf-8');
    hold({ kind: 'move-marker', path: markerPath });
    killHolder();

    // Without this, a crash between writeMarker({phase:'failed'}) and
    // resumeProject would block the project forever.
    expect(isHeld()).toBe(false);
  });

  // --- the two definitions of held-ness must not diverge -------------------

  it('a lease that READS free can actually be TAKEN by a different owner', () => {
    // Regression: the conflict check used to test `released_at === null` on
    // the raw record while every reader derived held-ness. A lease whose
    // holder died and whose operation finished then read free to everyone,
    // appeared in no listing, and still refused acquisition — permanently,
    // with nothing left to sweep it.
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder();
    fs.rmSync(journalPath);

    expect(isHeld()).toBe(false);
    expect(() =>
      acquireProjectLease(PROJECT, 'grove-move', 'moving', null, mycoHome, testPerUserLockNamespace),
    ).not.toThrow();
  });

  it('a lease that reads HELD still refuses a different owner', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder(); // dead holder, but the operation is unfinished → held

    expect(isHeld()).toBe(true);
    expect(() =>
      acquireProjectLease(PROJECT, 'grove-move', 'moving', null, mycoHome, testPerUserLockNamespace),
    ).toThrow(/project_lease_held|already being moved/i);
  });

  // --- malformed records fail closed ---------------------------------------

  it('a partially-shaped holder is treated as HELD, not silently freed', () => {
    // `{}` and `{pid}` yield an undefined boot_id; a numeric comparison on it
    // is false, so the holder read DEAD and a null-evidence lease was freed —
    // reachable with no torn write at all, and the opposite of the documented
    // fail-closed posture.
    hold(null);
    const leaseFile = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    for (const badHolder of [{}, { pid: 123 }, { boot_id: 'x' }, 'not-an-object']) {
      const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf-8'));
      lease.holder = badHolder;
      fs.writeFileSync(leaseFile, JSON.stringify(lease, null, 2), 'utf-8');
      expect(
        readProjectLease(PROJECT, mycoHome).state,
        `holder=${JSON.stringify(badHolder)} must not resolve free`,
      ).not.toBe('absent');
    }
  });

  // --- interaction with the existing contract -----------------------------

  it('a released lease stays free even with a live holder and a live operation', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    releaseProjectLease(PROJECT, OWNER, mycoHome, testPerUserLockNamespace);

    expect(isHeld()).toBe(false);
  });

  it('re-stamps the holder on a crash-resumed re-acquire by the same owner', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    killHolder();
    const staleHolder = JSON.parse(
      fs.readFileSync(path.join(mycoHome, 'leases', `${PROJECT}.json`), 'utf-8'),
    ).holder;

    // G2: the same owner re-entering after a crash is admitted, and the
    // record must now name the process that actually holds it.
    hold(journalEvidence());

    const fresh = JSON.parse(
      fs.readFileSync(path.join(mycoHome, 'leases', `${PROJECT}.json`), 'utf-8'),
    ).holder;
    expect(fresh.boot_id).not.toBe(staleHolder.boot_id);
    expect(isHeld()).toBe(true);
  });

  it('the generation still advances monotonically across a crash (G3)', () => {
    writeJournal('pushing');
    hold(journalEvidence());
    const first = readProjectLease(PROJECT, mycoHome);
    killHolder();
    hold(journalEvidence());
    const second = readProjectLease(PROJECT, mycoHome);

    expect(first.state).toBe('present');
    expect(second.state).toBe('present');
    if (first.state === 'present' && second.state === 'present') {
      expect(second.value.generation).toBeGreaterThan(first.value.generation);
    }
  });
});
