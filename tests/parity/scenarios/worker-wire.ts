import { expect } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../../helpers/stub-acp-harness.ts';
import { RUN_CLOSE_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget, waitFor } from '../harness.ts';

/** Well under the scenario timeout, so a worker that cannot claim reports rather than hangs. */
const ATTACH_BOUND_MS = 45_000;
/** How far ahead another scenario's queued run is parked while this one claims, and back again afterwards. */
const PARK_MS = 3_600_000;

/**
 * The shipped worker attached to a booted Deployment, on both targets.
 *
 * The worker is the real one — `runWorker` over `fetch` against the target's own
 * URL — so every header it composes is the header a Deployment receives. That is
 * the whole point of doing this here: the in-process tests drive the claim
 * handler with a fetch a test wrote, and a worker that declared no member
 * protocol passed all of them while every booted Deployment answered it 409 and
 * drove nothing.
 *
 * The harness is a stub on PATH and the model is never reached; what is under
 * test is the wire from a claim to an outcome, which runs the same on a machine
 * with three real harnesses.
 *
 * The stub answers `end_turn` without ever calling the Deployment back, which is
 * exactly the harness this Deployment must not believe: the run is a titling run
 * and the session it names is never titled, so the outcome the row carries is
 * `failed` with what the task owed, on both targets. A worker's `completed`
 * report is still accepted — the lease ends and the run credential is retired —
 * for a run that is over whatever it left behind.
 */
export const workerWire: ParityScenario = {
  name: 'the worker wire: a claim, a lease and the outcome the Deployment judges, from the shipped worker against a booted Deployment',
  async run(target: ParityTarget) {
    const now = Date.now();
    // The turn is held open until this scenario releases it, so the run is still
    // being driven when the row is read BECAUSE it has not been released — not
    // because the read arrived in time. A `wrangler d1 execute` read costs
    // seconds, which no delay in the harness can be sized against.
    const release = join(mkdtempSync(join(tmpdir(), 'myco-parity-release-')), 'release');
    const releaseTurn = (): void => { if (!existsSync(release)) writeFileSync(release, ''); };
    // The offer a claim carries is built from this, so an undetected stub would
    // read as a Deployment with no work rather than as a machine with no harness.
    expect(stubAcpHarness({ holdUntil: release })).toEqual(STUB_DETECTED);

    // A claim takes the OLDEST queued run the Deployment holds, so this row has
    // to be the one at the front — without ending runs this scenario does not
    // own, and without depending on running last. Anything already waiting is
    // moved back in the queue rather than completed, and moved forward again
    // afterwards by the same offset, so relative order survives.
    const runId = `run_parity_wire_${now}`;
    const sessionId = `sess_parity_wire_${now}`;
    const parked = (await target.sql(
      `SELECT id FROM agent_runs WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL`,
    )).map((r) => String((r as { id: string }).id));
    const shiftParked = async (by: number): Promise<void> => {
      if (parked.length === 0) return;
      await target.sql(`UPDATE agent_runs SET queued_at = queued_at + (${by}) WHERE id IN (${parked.map(lit).join(', ')})`);
    };
    await shiftParked(PARK_MS);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    // The session the run is dispatched to title. A stub that never calls back
    // leaves it untitled, which is the whole reading this scenario takes. The
    // row is what the dispatcher records: the titling parameters ride the
    // launch spec, and the claim builds the prompt from them.
    await target.sql(
      `INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
       VALUES (${lit(target.projectId)}, ${lit(sessionId)}, 'm_parity', 'tok_parity', ${now}, ${now})`,
    );
    await target.sql(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES (${lit(target.projectId)}, ${lit(runId)}, 'myco-agent', 'title-summary', 'queued', ${now}, 'worker',
               ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120, params: { session_id: sessionId, mode: 'claim' } }))},
               ${lit(JSON.stringify({ timeoutSeconds: 120, session_id: sessionId, mode: 'claim' }))}, NULL)`,
    );

    /**
     * The worker's own fetch, with the edge header wrangler dev never injects —
     * the same supply every parity scenario makes through `memberHeadersFor`.
     * The worker's own headers are passed through untouched: the credential, the
     * protocol it speaks and the content type are what the Deployment answers.
     */
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => fetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' },
    })) as typeof fetch;

    const row = async () =>
      (await target.sql(
        `SELECT status, harness, error, leased_by IS NOT NULL AS leased, dispatched_by AS dispatchedBy FROM agent_runs WHERE id = ${lit(runId)}`,
      ))[0] as { status: string; harness: string | null; error: string | null; leased: number; dispatchedBy: string | null };

    /** What this scenario asserts while the attachment is live. */
    const drove = async (attached: Promise<WorkerOutcome>, lines: string[], ended: () => WorkerOutcome | null): Promise<void> => {
      // The claim is answered, and the row says so while the run is still being
      // driven: running, on the harness the Deployment chose, under a lease.
      //
      // A worker that ended before the row moved is waited for too, and reported
      // as itself. Without that, a Deployment that refused the worker and a run
      // that was never claimed print the same unmoved row, and a refusal reads as
      // a queue nobody took.
      const reached = await waitFor(
        async () => ({ row: await row(), ended: ended() }),
        (s) => s.row?.status === 'running' || s.ended !== null,
        30_000,
      );
      if (reached.ended !== null) {
        throw new Error(
          `${target.name}: the worker ended before the run was driven — drove ${reached.ended.driven},`
          + ` refused ${String(reached.ended.refused)}; log: ${lines.join(' | ')}`,
        );
      }
      const running = reached.row;
      expect(`${target.name} while driven: ${running?.status} harness=${running?.harness} leased=${running?.leased}`)
        .toBe(`${target.name} while driven: running harness=${STUB_HARNESS} leased=1`);
      // The run credential the claim answered the worker with, named on the row
      // while the run is live. Its retirement is what the end is checked by.
      const minted = running.dispatchedBy ?? '';
      expect(minted).not.toBe('');

      // Everything above was read with the turn still open. Only now does the
      // harness get to finish.
      releaseTurn();
      const { driven, refused } = await attached;
      expect(`${target.name} attached: drove ${driven}, refused ${String(refused)}; log: ${lines.join(' | ')}`)
        .toBe(`${target.name} attached: drove 1, refused null; log: ${lines.join(' | ')}`);
      expect(lines.some((l) => l.startsWith(`claimed ${runId}`))).toBe(true);

      // `/worker/end` is what moves the row off running, and the credential the
      // claim minted for THIS run is retired as the row stops naming it.
      expect(await target.sql(`SELECT tokens_used, cost_usd, actual_cost_usd, estimated_cost_usd, cost_source, usage_data
        FROM agent_runs WHERE id = ${lit(runId)}`)).toEqual([{
        tokens_used: null, cost_usd: null, actual_cost_usd: null, estimated_cost_usd: null, cost_source: 'unavailable', usage_data: null,
      }]);
      const finalRow = await row();
      expect(`${target.name} ended: ${finalRow.status} — ${finalRow.error ?? 'no error'}`)
        .toBe(`${target.name} ended: failed — ${RUN_CLOSE_ERROR}`);
      expect(await target.sql(
        `SELECT revoked_at IS NOT NULL AS revoked FROM member_credentials WHERE id = ${lit(minted)}`,
      )).toEqual([{ revoked: 1 }]);
    };

    // A worker that cannot claim polls by design, so the attachment is bounded
    // by this scenario's own signal: a stall ends with the worker's log rather
    // than with the scenario's timeout.
    const lines: string[] = [];
    const stopping = new AbortController();
    const bound = setTimeout(() => { stopping.abort(); }, ATTACH_BOUND_MS);
    let finished: WorkerOutcome | null = null;
    const attached = runWorker({
      serverUrl: target.url,
      token: target.memberToken,
      runRoot: mkdtempSync(join(tmpdir(), 'myco-parity-worker-')),
      only: [STUB_HARNESS],
      once: true,
      pollIdleMs: 500,
      log: (line) => { lines.push(line); },
      fetchImpl,
      signal: stopping.signal,
    }).then((outcome) => { finished = outcome; return outcome; });

    try {
      await drove(attached, lines, () => finished);
    } finally {
      // A thrown assertion must still end the attachment: a scenario that threw
      // while its worker kept polling would leave it claiming the next
      // scenario's runs. Releasing first lets the harness finish on its own
      // rather than being killed mid-turn. The queue is handed back in the order
      // it was found.
      releaseTurn();
      clearTimeout(bound);
      stopping.abort();
      await attached.catch(() => undefined);
      await shiftParked(-PARK_MS);
    }
  },
};
