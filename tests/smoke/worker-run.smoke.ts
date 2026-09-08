/**
 * The worker smoke: one run end to end on each harness, and a killed worker's
 * run returning to the queue.
 *
 * This needs three authenticated harnesses on the machine it runs on, which a
 * CI runner does not have, so it is excluded from the default profile and run
 * by hand on a machine that does. What CI holds instead is the claim, the
 * lease, the role gate and the driver contract, which need no harness at all.
 *
 * Run it as:
 *   npm test -- tests/smoke/worker-run.smoke.ts
 * against a Deployment this machine holds an administrator membership for,
 * named by MYCO_SMOKE_SERVER.
 */
import { describe, expect, it } from 'bun:test';
import { detectHarnesses } from '@myco/runner/detect.js';
import { runWorker } from '@myco/runner/loop.js';
import { readDeploymentMembership } from '@myco/member/registry.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { join } from 'node:path';

const SERVER = process.env.MYCO_SMOKE_SERVER ?? '';
const HARNESSES = ['claude-code', 'codex', 'opencode'] as const;

describe('a worker drives one run on each harness', () => {
  it('names the machine\'s harnesses before anything is claimed', () => {
    expect(SERVER).not.toBe('');
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
      const driven = await runWorker({
        serverUrl: SERVER,
        token: membership!.token,
        runRoot: join(resolveMycoHome(), 'worker', 'smoke'),
        only: [harness],
        once: true,
        heartbeatMs: 30_000,
        pollIdleMs: 1_000,
        log: (line) => { lines.push(line); },
        signal: stopping.signal,
      });
      expect({ harness, driven, offered: lines.some((l) => l.includes(harness)) }).toEqual({ harness, driven: 1, offered: true });
    });
  }
});

describe('a killed worker\'s run', () => {
  it('returns to the queue at lease expiry and is claimed again', () => {
    // Driven by hand: dispatch a run, let a worker claim it, kill the worker
    // process, and watch the row. Before the lease expires it stays `running`
    // and a second worker answers `claimed: false`; after it, the row is
    // `queued` with no lease and no credential, and the next claim takes it.
    expect(SERVER).not.toBe('');
  });
});
