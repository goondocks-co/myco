import { expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import { stubProfileHarness, PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS } from '../../helpers/stub-profile-harness.ts';
import { RUN_CLOSE_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { MACHINE_ID, MEMBER_ID, type ParityScenario, type ParityTarget, waitFor } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';
import { owner } from '../clients/requests.ts';
import { askTitle, captureSession, runDetail } from '../clients/runs.ts';

/** Well under the scenario timeout, so a worker that cannot claim reports rather than hangs. */
const ATTACH_BOUND_MS = 45_000;
/**
 * The renewal cadence the claim's answer is rewritten to, so a held turn renews
 * several times inside the scenario. The lease the Deployment grants is its own.
 * The worker bounds its claim and end by the same cadence, so it is kept well
 * above what an end takes on a loaded runner.
 */
const HEARTBEAT_MS = 1_000;
/** How many renewals, each answered held, the run must see while it is driven. */
const RENEWALS = 3;
/** Three calls in the stub's stream, and the steps its worker keeps of them. */
const STEP_LINES = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_material","name":"mcp__myco__myco_run_sessions","input":{"op":"material"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_material","content":"material"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"AGENTS.md"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"# rules"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Bash","input":{"command":"ls -la"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","content":"total 0"}]}}',
];
const STEPS_KEPT = [
  { seq: 0, callId: 'tu_material', kind: 'myco', tool: 'mcp__myco__myco_run_sessions', target: 'material', outcome: 'ok' },
  { seq: 1, callId: 'tu_1', kind: 'read', tool: 'Read', target: 'AGENTS.md', outcome: 'ok' },
  { seq: 2, callId: 'tu_2', kind: 'command', tool: 'Bash', target: 'ls -la', outcome: 'ok' },
];

/** The shipped worker claims, renews, reads material, sends steps and ends without its required title or report. */
export const workerWire: ParityScenario = {
  name: 'the worker wire: a claim, a lease and the outcome the Deployment judges, from the shipped worker against a booted Deployment',
  dedicated: { timeoutMs: 120_000 },
  async run(target: ParityTarget) {
    const now = Date.now();
    // The stub holds its turn until the scenario releases it.
    const scratch = mkdtempSync(join(tmpdir(), 'myco-parity-release-'));
    const release = join(scratch, 'release');
    const receipt = join(scratch, 'mcp-material.json');
    const releaseTurn = (): void => { if (!existsSync(release)) writeFileSync(release, ''); };
    // The offer a claim carries is built from this, so an undetected stub would
    // read as a Deployment with no work rather than as a machine with no harness.
    expect(stubProfileHarness({ holdUntil: release, mcpReceipt: receipt, lines: STEP_LINES })).toEqual(PROFILE_STUB_DETECTED);

    const credentialLeaf = `agent.harnesses.${PROFILE_STUB_HARNESS}.credential`;
    const settings = await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(settings.status).toBe(200);
    const previous = ((await settings.json()) as { leaves: Array<{ leaf: string; configured: boolean; value: unknown }> }).leaves
      .find((entry) => entry.leaf === credentialLeaf);
    if (previous === undefined) throw new Error(`${target.name}: missing ${credentialLeaf} setting`);
    const credentialSetting = async (method: 'PUT' | 'DELETE', value?: unknown) => fetch(`${target.url}/api/settings/${credentialLeaf}`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...await revisionHeaders(target, `/api/settings/${credentialLeaf}`) },
      ...(method === 'PUT' ? { body: JSON.stringify({ value }) } : {}),
    });

    const sessionId = `sess_parity_wire_${now}`;
    await captureSession(target, sessionId, 'Observe the worker wire');
    const runId = await askTitle(target, sessionId);

    /**
     * The worker's own fetch, with the edge header wrangler dev never injects —
     * the same supply every parity scenario makes through `memberHeadersFor`.
     * The worker's own headers are passed through untouched: the credential, the
     * protocol it speaks and the content type are what the Deployment answers.
     */
    const renewals: boolean[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' },
      });
      const path = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).pathname;
      if (path === '/worker/lease') renewals.push(((await response.clone().json()) as { held?: unknown }).held === true);
      if (path !== '/worker/claim') return response;
      const answer = await response.json() as Record<string, unknown>;
      return Response.json(answer.claimed === true ? { ...answer, heartbeatMs: HEARTBEAT_MS } : answer, { status: response.status, headers: response.headers });
    }) as typeof fetch;

    const row = async () => (await runDetail(target, runId)).run;

    /** What this scenario asserts while the attachment is live. */
    const drove = async (attached: Promise<WorkerOutcome>, lines: string[], ended: () => WorkerOutcome | null): Promise<void> => {
      // A refused worker ends the wait even when its run remains queued.
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
      expect(`${target.name} while driven: ${running?.status} harness=${running?.harness} leased=${running?.leaseExpiresAt !== null}`)
        .toBe(`${target.name} while driven: running harness=${PROFILE_STUB_HARNESS} leased=true`);
      // The run credential the claim answered the worker with, named on the row
      // while the run is live. Its retirement is what the end is checked by.
      const minted = running.dispatchedBy ?? '';
      expect(minted).not.toBe('');
      // Only the child receives the run's MCP connection and reads its material.
      await waitFor(async () => existsSync(receipt) || ended() !== null, Boolean, 20_000);
      expect(existsSync(receipt)).toBe(true);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ session_id: sessionId, prompt_count: 1 });

      // The lease is renewed while the run is driven, and every renewal is
      // answered held: nothing else takes a run whose lease is live.
      await waitFor(async () => renewals.length, (n) => n >= RENEWALS || ended() !== null, 20_000);
      expect(`${target.name} renewals: ${renewals.length >= RENEWALS} refused ${renewals.filter((held) => !held).length}`)
        .toBe(`${target.name} renewals: true refused 0`);

      // Everything above was read with the turn still open. Only now does the
      // harness get to finish.
      releaseTurn();
      const { driven, refused } = await attached;
      expect(`${target.name} attached: drove ${driven}, refused ${String(refused)}; log: ${lines.join(' | ')}`)
        .toBe(`${target.name} attached: drove 1, refused null; log: ${lines.join(' | ')}`);
      expect(lines.some((l) => l.startsWith(`claimed ${runId}`))).toBe(true);

      // `/worker/end` is what moves the row off running, and the credential the
      // claim minted for THIS run is retired as the row stops naming it. An end
      // whose answer the worker's deadline cut short is still the Deployment's
      // to finish, so the row is waited for rather than read once.
      await waitFor(row, (r) => r?.status !== 'running', 20_000);
      const detail = await runDetail(target, runId), accounted = detail.run;
      expect(accounted).toMatchObject({ tokensUsed: null, costUsd: null, actualCostUsd: null, estimatedCostUsd: null, costSource: 'unavailable' });
      expect(JSON.parse(accounted.usageData)).toMatchObject({
        accountingVersion: 1, model: 'claude-sonnet-5-5', provider: 'anthropic',
        identity: { status: 'reported', source: 'system.init.model', primary: { model: 'claude-sonnet-5-5', provider: 'anthropic' } },
      });
      const finalRow = await row();
      expect(`${target.name} ended: ${finalRow.status} — ${finalRow.error ?? 'no error'}`)
        .toBe(`${target.name} ended: failed — ${RUN_CLOSE_ERROR}`);
      expect(detail.attempts).toEqual([expect.objectContaining({ attemptId: minted, steps: expect.objectContaining({ total: 3, overflow: 0 }) })]);
      const steps = await owner(target, `/api/projects/${target.projectId}/runs/${runId}/steps?attempt=${minted}`);
      expect(steps.status).toBe(200);
      expect(steps.body.rows.map(({ seq, callId, kind, tool, target, outcome }: any) => ({ seq, callId, kind, tool, target, outcome }))).toEqual(STEPS_KEPT);
      const credentials = await owner(target, '/api/credentials?purpose=run&limit=100');
      expect(credentials.status).toBe(200);
      expect(credentials.body.rows.find((credential: any) => credential.id === minted)).toMatchObject({ live: false, revokedAt: expect.any(Number) });
      expect(detail.run).toMatchObject({ worker: { machineId: MACHINE_ID, member: { id: MEMBER_ID } }, leaseExpiresAt: null });

    };

    // A worker that cannot claim polls by design, so the attachment is bounded
    // by this scenario's own signal: a stall ends with the worker's log rather
    // than with the scenario's timeout.
    const lines: string[] = [];
    const stopping = new AbortController();
    const bound = setTimeout(() => { stopping.abort(); }, ATTACH_BOUND_MS);
    let finished: WorkerOutcome | null = null;
    const runRoot = mkdtempSync(join(tmpdir(), 'myco-parity-worker-'));
    let attached: Promise<WorkerOutcome> | null = null;
    try {
      const configured = await credentialSetting('PUT', 'worker-login');
      expect({ status: configured.status, body: await configured.json() }).toEqual({ status: 200, body: { applied: true } });
      attached = runWorker({
        serverUrl: target.url,
        token: target.memberToken, lockDir: null,
        runRoot,
        only: [PROFILE_STUB_HARNESS],
        once: true,
        pollIdleMs: 500,
        log: (line) => { lines.push(line); },
        fetchImpl,
        signal: stopping.signal,
      }).then((outcome) => { finished = outcome; return outcome; });
      await drove(attached, lines, () => finished);
    } finally {
      // Release the stub and stop the attachment on every exit.
      releaseTurn();
      clearTimeout(bound);
      stopping.abort();
      await attached?.catch(() => undefined);
      rmSync(runRoot, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
      const restored = await credentialSetting(previous.configured ? 'PUT' : 'DELETE', previous.value);
      expect({ status: restored.status, body: await restored.json() }).toEqual({ status: 200, body: { applied: true } });
    }
  },
};
