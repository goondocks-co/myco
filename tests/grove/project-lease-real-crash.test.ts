/**
 * Gate W4, the half that matters most: a REAL dead process, in the SAME boot.
 *
 * `project-lease-liveness.test.ts` simulates a crash by rewriting the record's
 * `boot_id`, which is the REBOOT case. That is the rare one. The common crash
 * — daemon killed by OOM, `kill -9`, a segfault, an upgrade restart — leaves
 * the boot id intact and only the pid dead, and a boot-id-only simulation
 * never reaches `process.kill(pid, 0)` at all.
 *
 * The gap was demonstrated, not theorised: a mutant `isHolderAlive` with the
 * pid check deleted (`same boot ⇒ alive`) passed the entire liveness gate,
 * 8 of 8. In production that mutant means a crashed daemon's lease reads held
 * until the next reboot — exactly the stranding W4 exists to remove. So the
 * most likely regression in this mechanism was the one thing the gate could
 * not see.
 *
 * This file spawns a real child, lets it take a real lease, SIGKILLs it, and
 * asserts against the pid that is genuinely gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectLease, type LeaseEvidence } from '@myco/grove/project-lease.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

const PROJECT = assertGroveProjectId('proj_' + 'f'.repeat(32));
const SRC = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src');

describe('W4 — a REAL dead holder in the same boot', () => {
  let mycoHome: string;
  let childScript: string;
  let journalPath: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-w4-crash-'));
    journalPath = path.join(mycoHome, 'residency', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    childScript = path.join(mycoHome, 'holder.ts');
    fs.writeFileSync(
      childScript,
      `const { acquireProjectLease } = await import(${JSON.stringify(`${SRC}/grove/project-lease.ts`)});\n`
      + 'const [, , home, projectId, evidenceJson] = process.argv;\n'
      + "acquireProjectLease(projectId, 'residency-detach', 'detaching', "
      + "evidenceJson === 'null' ? null : JSON.parse(evidenceJson), home);\n"
      + "console.log('ACQUIRED');\n"
      + 'setInterval(() => {}, 1000);\n',
      'utf-8',
    );
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  /** Spawn a holder, wait for its lease, and return a kill handle. */
  async function spawnHolder(evidence: LeaseEvidence | null): Promise<{ kill: () => void; pid: number }> {
    const child = Bun.spawn(
      ['bun', 'run', childScript, mycoHome, PROJECT, evidence === null ? 'null' : JSON.stringify(evidence)],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const leaseFile = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(leaseFile)) break;
      await Bun.sleep(50);
    }
    if (!fs.existsSync(leaseFile)) {
      throw new Error(`holder never acquired: ${await new Response(child.stderr).text()}`);
    }
    return { kill: () => child.kill(9), pid: child.pid };
  }

  /** Wait for the OS to reap the pid, so `process.kill(pid,0)` really fails. */
  async function waitForReaped(pid: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error(`pid ${pid} still alive after kill`);
  }

  const isHeld = () => readProjectLease(PROJECT, mycoHome).state === 'present';

  function writeJournal(phase: string): void {
    fs.writeFileSync(journalPath, JSON.stringify({ project_id: PROJECT, phase }), 'utf-8');
  }

  it('is held while a real holder process is alive', async () => {
    writeJournal('done'); // terminal, so ONLY pid liveness can hold it
    const holder = await spawnHolder({ kind: 'residency-journal', path: journalPath });
    try {
      expect(isHeld()).toBe(true);
    } finally {
      holder.kill();
    }
  });

  it('frees when the real holder is SIGKILLed and its operation is finished', async () => {
    // The case a boot_id rewrite cannot reach: same boot, genuinely dead pid.
    // A regression that stopped checking the pid would keep this held.
    writeJournal('done');
    const holder = await spawnHolder({ kind: 'residency-journal', path: journalPath });
    holder.kill();
    await waitForReaped(holder.pid);

    expect(isHeld()).toBe(false);
  });

  it('stays held when the real holder is SIGKILLed mid-transition', async () => {
    // The other polarity: dead pid, but the journal is non-terminal, so the
    // transition is resumable and the project must stay blocked.
    writeJournal('pushing');
    const holder = await spawnHolder({ kind: 'residency-journal', path: journalPath });
    holder.kill();
    await waitForReaped(holder.pid);

    expect(isHeld()).toBe(true);
  });

  it('frees a SIGKILLed holder that declared no evidence', async () => {
    const holder = await spawnHolder(null);
    holder.kill();
    await waitForReaped(holder.pid);

    expect(isHeld()).toBe(false);
  });
});
