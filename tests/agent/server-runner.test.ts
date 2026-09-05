/**
 * The lean server-mode runner against the deployed entry: claim, harness
 * execution with the materialized report surface, the report landing over
 * `/runs/report`, and the terminal status — with no local vault anywhere.
 */
import { describe, expect, it } from 'bun:test';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID, MAX_RUN_ERROR_CHARS as SERVER_MAX_RUN_ERROR_CHARS } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import worker from '@myco-server-worker/index.js';
import { ServerClient } from '@myco/member/transport.js';
import {
  CAPTURE_DRIVEN_ADMISSION, installRunFailureHandlers, MAX_RUN_ERROR_CHARS, RECLAIM_WARNING_MS, RUN_DEADLINE_ERROR, RUN_REFUSED_CLOSE_ERROR,
  RUN_RECLAIMED_ERROR, runServerTask, type HeldRun,
} from '@myco/agent/runtime/server-runner.js';
import type { AgentHarness, HarnessExecuteInput } from '@myco/agent/harness/types.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const AGENT = 'myco-agent';

async function harness() {
  const fixture = sqliteEnv();
  const t = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(Date.now());
  const client = new ServerClient(
    { serverUrl: 'https://s', token: t.token, projectId: 'proj_1' },
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set('cf-connecting-ip', '1.2.3.4');
      return worker.fetch(request, fixture.env);
    }) as typeof fetch,
  );
  return { ...fixture, client };
}

const budget = { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 };

/** A harness that behaves like a model calling the one tool it was handed. */
function fakeHarness(behavior: 'reports' | 'silent' | 'throws'): AgentHarness {
  return {
    async execute(input: HarnessExecuteInput) {
      if (behavior === 'throws') throw new Error('provider unreachable');
      if (behavior === 'reports') {
        const reportTool = input.toolSurface.tools?.find((t) => t.name === 'vault_report');
        expect(reportTool).toBeDefined();
        await reportTool!.handler({ action: 'container-smoke', summary: 'runtime works', details: { note: 'smoke' } }, {});
      }
      return { finalText: 'done', turnsUsed: 1, usage: { totalTokens: 42 } as never };
    },
    supports: () => false,
  } as unknown as AgentHarness;
}

describe('runServerTask', () => {
  it('claims, executes with the materialized report surface, lands the report, and completes the run', async () => {
    const { client, sqlite } = await harness();
    const result = await runServerTask({ client, budget, runId: 'run_smoke_1', taskName: 'container-smoke', harness: fakeHarness('reports') });
    // The Deployment applied the ending this run posted, which is what `ending` says.
    expect(result).toEqual({ runId: 'run_smoke_1', status: 'completed', ending: 'posted', reportCount: 1 });

    const run = sqlite.query(`SELECT status, task, tokens_used t FROM agent_runs WHERE id = 'run_smoke_1'`).get() as { status: string; task: string; t: number };
    expect(run).toEqual({ status: 'completed', task: 'container-smoke', t: 42 });
    const report = sqlite.query(`SELECT action, summary FROM agent_reports WHERE run_id = 'run_smoke_1'`).get() as { action: string; summary: string };
    expect(report).toEqual({ action: 'container-smoke', summary: 'runtime works' });
  });

  it('records a failed run when the harness throws, and answers skipped when another run holds the task', async () => {
    const { client, sqlite } = await harness();
    const failed = await runServerTask({ client, budget, runId: 'run_smoke_2', taskName: 'container-smoke', harness: fakeHarness('throws') });
    expect({ status: failed.status, error: failed.error }).toEqual({ status: 'failed', error: 'provider unreachable' });
    expect((sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'run_smoke_2'`).get() as { status: string; error: string })).toEqual({ status: 'failed', error: 'provider unreachable' });

    await runServerTask({ client, budget, runId: 'run_smoke_3', taskName: 'container-smoke', harness: fakeHarness('silent') });
    // run_smoke_3 completed; a fresh claim within the window is refused → skipped
    const rows = sqlite.query(`SELECT id, status FROM agent_runs ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(rows.map((r) => r.id)).toContain('run_smoke_3');
  });

  it('runs title-summary with the session tools, claiming on the provider gate with the dispatch\'s parameters as its context, and the prompt naming the session', async () => {
    const { client, sqlite } = await harness();
    sqlite.query(`DELETE FROM project_capabilities`).run();
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"anthropic"', 1, 'test')`).run();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', 'sess_1', 'machine_1', 'tok_1', 1, 2, 'claude-code')`).run();
    let seen: { names: string[]; prompt: string } | null = null;
    const observing: AgentHarness = {
      async execute(input: HarnessExecuteInput) {
        seen = { names: (input.toolSurface.tools ?? []).map((t) => t.name), prompt: input.prompt };
        return { finalText: 'done', turnsUsed: 1, usage: { totalTokens: 7 } as never };
      },
      supports: () => false,
    } as unknown as AgentHarness;
    const params = { session_id: 'sess_1', mode: 'claim' };
    const result = await runServerTask({ client, budget, runId: 'run_title_1', taskName: 'title-summary', harness: observing, params, admission: CAPTURE_DRIVEN_ADMISSION });
    expect(result.status).toBe('completed');
    expect(seen!.names).toEqual(['vault_report', 'vault_session_summary_material', 'vault_update_session']);
    expect(seen!.prompt).toContain('Target session: sess_1');
    const run = sqlite.query(`SELECT status, task, run_context c FROM agent_runs WHERE id = 'run_title_1'`).get() as { status: string; task: string; c: string };
    expect(run).toEqual({ status: 'completed', task: 'title-summary', c: JSON.stringify(params) });
    // Every other task holds the report tool alone.
    let smokeNames: string[] = [];
    const smoke: AgentHarness = { async execute(input: HarnessExecuteInput) { smokeNames = (input.toolSurface.tools ?? []).map((t) => t.name); return { finalText: 'done', turnsUsed: 1 } as never; }, supports: () => false } as unknown as AgentHarness;
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, 1, 'test')`).run();
    await runServerTask({ client, budget, runId: 'run_smoke_5', taskName: 'container-smoke', harness: smoke, admission: 'cortex' });
    expect(smokeNames).toEqual(['vault_report']);
  });

  it('reads its prompt off the run row, and composes a phased task into one query', async () => {
    const fixture = sqliteEnv();
    const now = Date.now();
    fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(now);
    await ensureMember(fixture.db, HARNESS_MEMBER_ID, now, 'harness runtime');
    const minted = await issueMemberToken(fixture.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
    await recordDispatch(fixture.db, { projectId: 'proj_1' }, {
      id: 'run_cortex_1', agentId: AGENT, task: 'cortex-instructions', instruction: 'THE SERVER PROMPT',
      provider: 'anthropic', model: null, runContext: JSON.stringify({ input_hash: 'h' }), dispatchedBy: minted.tokenId, startedAt: now,
    });
    const client = new ServerClient(
      { serverUrl: 'https://s', token: minted.token, projectId: 'proj_1' },
      ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        request.headers.set('cf-connecting-ip', '1.2.3.4');
        return worker.fetch(request, fixture.env);
      }) as typeof fetch,
    );
    let seen: { names: string[]; prompt: string } | null = null;
    const observing: AgentHarness = {
      async execute(input: HarnessExecuteInput) {
        seen = { names: (input.toolSurface.tools ?? []).map((t) => t.name), prompt: input.prompt };
        return { finalText: 'done', turnsUsed: 1, usage: { totalTokens: 9 } as never };
      },
      supports: () => false,
    } as unknown as AgentHarness;
    await runServerTask({ client, budget, runId: 'run_cortex_1', taskName: 'cortex-instructions', harness: observing, admission: 'cortex' });
    expect(seen!.names).toEqual(['vault_report', 'vault_spores', 'vault_spore', 'vault_sessions', 'vault_read_digest']);
    expect(seen!.prompt).toContain('THE SERVER PROMPT');
    expect(seen!.prompt).toContain('## Phase: research');
    expect(seen!.prompt).toContain('## Phase: author');
  });

  it('fails an unknown task by name without claiming anything', async () => {
    const { client, sqlite } = await harness();
    const result = await runServerTask({ client, budget, runId: 'run_smoke_4', taskName: 'no-such-task', harness: fakeHarness('silent') });
    expect({ status: result.status, error: result.error }).toEqual({ status: 'failed', error: 'unknown task: no-such-task' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });
});

describe('a run that dies names itself', () => {
  it('fails at its own deadline, even where the harness never honours the abort', async () => {
    const { client, sqlite } = await harness();
    const hanging: AgentHarness = {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { finalText: 'too late', turnsUsed: 1 } as never;
      },
      supports: () => false,
    } as unknown as AgentHarness;
    const result = await runServerTask({ client, budget, runId: 'run_deadline', taskName: 'container-smoke', harness: hanging, timeoutSeconds: 0.05 });
    expect({ status: result.status, error: result.error }).toEqual({ status: 'failed', error: RUN_DEADLINE_ERROR });
    expect(sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'run_deadline'`).get())
      .toEqual({ status: 'failed', error: RUN_DEADLINE_ERROR });
  });

  it('fails with the message of an execution that rejects after its own turn', async () => {
    const { client, sqlite } = await harness();
    const late: AgentHarness = {
      execute: () => new Promise((_, reject) => setTimeout(() => reject(new Error('the provider closed the stream')), 5)),
      supports: () => false,
    } as unknown as AgentHarness;
    const result = await runServerTask({ client, budget, runId: 'run_late', taskName: 'container-smoke', harness: late });
    expect({ status: result.status, error: result.error }).toEqual({ status: 'failed', error: 'the provider closed the stream' });
    expect(sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'run_late'`).get())
      .toEqual({ status: 'failed', error: 'the provider closed the stream' });
  });

  it('lets a run in flight finish under a stop signal: nothing is posted, the run\'s own ending lands, and the drain then ends clean', async () => {
    const { client, sqlite } = await harness();
    const listeners = new Map<string, Array<(reason?: unknown) => void>>();
    const events = { on: (event: string, listener: (reason?: unknown) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
    const named: Array<{ error: string; named: boolean }> = [];
    const seen: string[] = [];
    let held: HeldRun | null = null;
    // A budget the run finishes well inside: the platform's own wall is minutes away.
    installRunFailureHandlers(events, {
      held: () => held,
      onNamed: (error, wasNamed) => { named.push({ error, named: wasNamed }); },
      onStopping: () => { seen.push('draining'); },
      onDrained: () => { seen.push('drained'); },
    }, { reclaimAfterMs: 10_000 });

    const takenMidRun = {
      async execute() {
        for (const listener of listeners.get('SIGTERM') ?? []) listener();
        await Bun.sleep(40);
        return { finalText: 'done', turnsUsed: 1, usage: { totalTokens: 7 } as never };
      },
      supports: () => false,
    } as unknown as AgentHarness;

    const result = await runServerTask({
      client, budget, runId: 'run_drained', taskName: 'container-smoke', harness: takenMidRun,
      onClaimed: () => { held = { client, budget, runId: 'run_drained' }; },
      onClosing: () => { held = null; },
    });
    await Bun.sleep(30);
    expect(result).toEqual({ runId: 'run_drained', status: 'completed', ending: 'posted', reportCount: 0 });
    expect(named).toEqual([]);
    expect(seen).toEqual(['draining']);
    expect(sqlite.query(`SELECT status, error, run_context c FROM agent_runs WHERE id = 'run_drained'`).get())
      .toEqual({ status: 'completed', error: null, c: null });
  });

  it('ends the drain at once in a container holding no run, and answers a second signal with nothing', async () => {
    const listeners = new Map<string, Array<(reason?: unknown) => void>>();
    const events = { on: (event: string, listener: (reason?: unknown) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
    const seen: string[] = [];
    installRunFailureHandlers(events, {
      held: () => null,
      onNamed: () => { seen.push('named'); },
      onStopping: () => { seen.push('draining'); },
      onDrained: () => { seen.push('drained'); },
    });
    for (const listener of listeners.get('SIGTERM') ?? []) listener();
    // A platform that sends SIGTERM again, or SIGINT after it, is answered once.
    for (const listener of [...(listeners.get('SIGTERM') ?? []), ...(listeners.get('SIGINT') ?? [])]) listener();
    await Bun.sleep(20);
    expect(seen).toEqual(['draining', 'drained']);
  });

  it('names a run still in flight when the drain budget runs out, marking it one a deployment replaced', async () => {
    const { client, sqlite } = await harness();
    await runServerTask({ client, budget, runId: 'run_reclaimed', taskName: 'container-smoke', harness: fakeHarness('silent') });
    sqlite.query(`UPDATE agent_runs SET status = 'running', completed_at = NULL, error = NULL WHERE id = 'run_reclaimed'`).run();

    const listeners = new Map<string, Array<(reason?: unknown) => void>>();
    const events = { on: (event: string, listener: (reason?: unknown) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
    const named: Array<{ error: string; named: boolean }> = [];
    let held: HeldRun | null = { client, budget, runId: 'run_reclaimed' };
    installRunFailureHandlers(events, {
      held: () => held,
      onNamed: (error, wasNamed) => { named.push({ error, named: wasNamed }); held = null; },
    }, { reclaimAfterMs: 5 });

    for (const listener of listeners.get('SIGTERM') ?? []) listener();
    await Bun.sleep(120);
    expect(named).toEqual([{ error: RUN_RECLAIMED_ERROR, named: true }]);
    const row = sqlite.query(`SELECT status, error, run_context c FROM agent_runs WHERE id = 'run_reclaimed'`).get() as { status: string; error: string; c: string };
    expect({ status: row.status, error: row.error }).toEqual({ status: 'failed', error: RUN_RECLAIMED_ERROR });
    expect(JSON.parse(row.c) as { replaced?: boolean }).toEqual({ replaced: true });

    // A signal after the reclaim spends nothing: the row already carries what happened.
    for (const listener of [...(listeners.get('SIGTERM') ?? []), ...(listeners.get('SIGINT') ?? [])]) listener();
    for (const listener of listeners.get('uncaughtException') ?? []) listener(new Error('and then this'));
    await Bun.sleep(30);
    expect(named).toHaveLength(1);
  });

  it('holds the drain budget inside the fifteen minutes the platform waits before the kill', () => {
    expect(RECLAIM_WARNING_MS).toBeLessThan(15 * 60_000);
    expect(RECLAIM_WARNING_MS).toBeGreaterThan(10 * 60_000);
  });

  it('names nothing for a death in a container holding no run, and says so', async () => {
    const listeners = new Map<string, Array<(reason?: unknown) => void>>();
    const events = { on: (event: string, listener: (reason?: unknown) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
    const named: Array<{ error: string; named: boolean }> = [];
    installRunFailureHandlers(events, { held: () => null, onNamed: (error, wasNamed) => { named.push({ error, named: wasNamed }); } });
    for (const listener of listeners.get('uncaughtException') ?? []) listener(new Error('nothing held'));
    await Bun.sleep(20);
    expect(named).toEqual([{ error: 'nothing held', named: false }]);
  });
});

describe('what the container makes of the deployment\'s answer', () => {
  it('reports a run the deployment refused to close as the failure the row calls it', async () => {
    // A Deployment that admits the claim and then refuses the close, answered in
    // the wire's own shape.
    const stub = {
      request: async (_method: string, path: string, options: { body: string }) => {
        const json = (() => {
          if (path === '/runs/claim') return { persisted: true, claimed: true };
          if (path === '/runs/update') {
            const update = (JSON.parse(options.body) as { update?: { status?: string } }).update;
            return update?.status === 'completed'
              ? { persisted: true, changed: 1, applied: false, reason: 'postcondition' }
              : { persisted: true, changed: 1 };
          }
          return { persisted: true };
        })();
        return { kind: 'json' as const, status: 200, json };
      },
    } as unknown as ServerClient;
    const result = await runServerTask({ client: stub, budget, runId: 'run_refused', taskName: 'container-smoke', harness: fakeHarness('silent') });
    // The row does not carry this run's ending, and the exit code says so.
    expect(result).toEqual({ runId: 'run_refused', status: 'failed', ending: 'unposted', error: RUN_REFUSED_CLOSE_ERROR, refused: 'postcondition', reportCount: 0 });
  });

  it('takes the run as its own only once the claim lands', async () => {
    const { client } = await harness();
    let claimed = 0;
    await runServerTask({ client, budget, runId: 'run_claim_1', taskName: 'container-smoke', harness: fakeHarness('silent'), onClaimed: () => { claimed += 1; } });
    expect(claimed).toBe(1);

    // A second run of the same task inside the window is refused the claim, and the container never holds it.
    let refusedClaims = 0;
    const second = await runServerTask({ client, budget, runId: 'run_claim_1', taskName: 'container-smoke', harness: fakeHarness('silent'), onClaimed: () => { refusedClaims += 1; } });
    expect(second.status).toBe('skipped');
    expect(refusedClaims).toBe(0);
  });
});

describe('how much of a failure rides a run row', () => {
  it('is the same bound wherever the failure is written', () => {
    // The runtime bounds the failures it posts; the Deployment bounds the
    // refusal it writes when the runtime never started. One row, one column.
    expect(MAX_RUN_ERROR_CHARS).toBe(SERVER_MAX_RUN_ERROR_CHARS);
  });
});
