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
 *   MYCO_SMOKE_SERVER=<url> MYCO_SMOKE_PROJECT=<id> npm test -- tests/smoke/worker-run.smoke.test.ts
 * against a Deployment this machine holds an administrator membership for.
 */
import { describe, expect, it } from 'bun:test';
import { detectHarnesses } from '@myco/runner/detect.js';
import { runWorker } from '@myco/runner/loop.js';
import { readDeploymentMembership } from '@myco/member/registry.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { memberHeaders } from '@myco/member/constants.js';
import { verifyWorkerOutcome } from '../helpers/worker-smoke-evidence.js';

const SERVER = process.env.MYCO_SMOKE_SERVER ?? '';
const PROJECT = process.env.MYCO_SMOKE_PROJECT ?? '';
const HARNESSES = (process.env.MYCO_SMOKE_HARNESSES ?? 'claude-code,codex,opencode').split(',');
const SMOKE_TIMEOUT_MS = 420_000;

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
      expect(PROJECT.length).toBeGreaterThan(0);
      const stopping = new AbortController();
      const timeout = setTimeout(() => stopping.abort(), SMOKE_TIMEOUT_MS);
      const lines: string[] = [];
      const client = new Client({ name: 'myco-worker-smoke', version: '1' });
      try {
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
        const disagreed = lines.filter((l) => l.includes('the Deployment recorded it') || l.includes('failed before its harness started'));
        expect({ harness, driven, refused, offered: lines.some((l) => l.includes(harness)), disagreed })
          .toEqual({ harness, driven: 1, refused: null, offered: true, disagreed: [] });
        const runId = lines.map((line) => /^claimed (\S+) /.exec(line)?.[1]).find(Boolean);
        expect(runId).toBeDefined();
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', SERVER), {
          requestInit: { headers: memberHeaders({ token: membership!.token, projectId: PROJECT }), signal: stopping.signal },
        }));
        console.log(JSON.stringify(await verifyWorkerOutcome(client, PROJECT, runId!)));
      } finally {
        clearTimeout(timeout);
        stopping.abort();
        await client.close();
      }
    }, SMOKE_TIMEOUT_MS + 5_000);
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
