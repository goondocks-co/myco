/**
 * The worker smoke: one run end to end on each harness, and a killed worker's
 * run returning to the queue.
 *
 * This needs three authenticated harnesses on the machine it runs on, which a
 * CI runner does not have. The default profile collects this file like any
 * other, so MYCO_SMOKE_SERVER is what selects it: with no Deployment named
 * there every test here skips, and it is run by hand on a machine that holds
 * the harnesses. What CI holds instead is the claim, the lease, the role gate
 * and the driver contract, which need no harness at all.
 *
 * Run it as:
 *   MYCO_SMOKE_SERVER=<url> npm test -- tests/smoke/worker-run.smoke.test.ts
 * against a Deployment this machine holds an administrator membership for.
 */
import { describe, expect, it } from 'bun:test';
import { detectHarnesses } from '@myco/runner/detect.js';
import { runWorker } from '@myco/runner/loop.js';
import { readDeploymentMembership } from '@myco/member/registry.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { join } from 'node:path';

const SERVER = process.env.MYCO_SMOKE_SERVER ?? '';
const HARNESSES = ['claude-code', 'codex', 'opencode'] as const;

describe.skipIf(SERVER === '')('a worker drives one run on each harness', () => {
  it('names the machine\'s harnesses before anything is claimed', () => {
    const found = detectHarnesses();
    const ready = found.filter((h) => h.authenticated).map((h) => h.id);
    // The smoke's whole premise: without these three logged in it proves nothing.
    for (const id of HARNESSES) expect({ harness: id, loggedIn: ready.includes(id) }).toEqual({ harness: id, loggedIn: true });
  });

  for (const harness of HARNESSES) {
    it(`drives one queued run to completion on ${harness}`, async () => {
      const membership = readDeploymentMembership(SERVER);
      expect(membership).not.toBeNull();
      const stopping = new AbortController();
      const lines: string[] = [];
      const { driven, refused } = await runWorker({
        serverUrl: SERVER,
        token: membership!.token,
        runRoot: join(resolveMycoHome(), 'worker', 'smoke'),
        only: [harness],
        once: true,
        pollIdleMs: 1_000,
        log: (line) => { lines.push(line); },
        signal: stopping.signal,
      });
      // The worker's own word is the harness ending its turn; the Deployment's
      // verdict is whether the run left its artifact behind, and it says so on
      // the worker's log only when the two disagree.
      // A run that failed on both sides also agrees, so the log must show the
      // harness calling a run tool and the worker starting it.
      const disagreed = lines.filter((l) => l.includes('the Deployment recorded it') || l.includes('failed before its harness started'));
      const called = lines.filter((l) => /^run \S+ called \S+: ok$/.test(l)).length;
      expect({ harness, driven, refused, offered: lines.some((l) => l.includes(harness)), disagreed, called: called > 0 })
        .toEqual({ harness, driven: 1, refused: null, offered: true, disagreed: [], called: true });
    });
  }
});

describe('a killed worker\'s run', () => {
  // Driven by hand, against a Deployment with a real worker attached:
  //   1. dispatch a run and let the worker claim it;
  //   2. `kill -9` the worker process;
  //   3. before the lease expires the row is `running` and a second worker
  //      answers `claimed: false`;
  //   4. after it, the row is `queued` with no lease and no credential;
  //   5. a restarted worker claims it.
  // The same behaviour is held against the clock in `worker-lease.test.ts`;
  // what this proves is that a real process dying produces it.
  it.skip('returns to the queue at lease expiry and is claimed again', () => {});
});
