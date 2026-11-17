import { backfillTitles } from '@myco-server-worker/core/titling.js';
import { runStaleSweep } from '@myco-server-worker/core/jobs-run.js';
import { dispatchLoad } from '@myco-server-worker/db/runs/live.js';
import { CompletionUnavailable, DIRECT_TITLE_BUDGET_MS, DIRECT_TITLE_SETTLEMENT_MS, COMPLETION_ATTEMPTS } from '@myco-server-worker/core/completion/provider.js';
import { TITLING_MAX_ATTEMPTS } from '@myco-server-worker/constants.js';
import { DIRECT_CALLS_PER_MINUTE } from '@myco-server-worker/core/completion/provider.js';
import type { CompletionProvider } from '@myco-server-worker/core/completion/provider.js';
import { singleTurnMaterial } from '@myco-server-worker/content/single-turn-material.js';
/**
 * The titling gate: one harness dispatch per ended session, queued for a worker
 * to claim, with the queued row carrying the whole launch the dispatch asked for
 * and no credential at all, and nothing of the Deployment's secrets in telemetry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import {
  cleanSummary,
  cleanTitle,
  titleSession,
  titleReadySessions,
} from '@myco-server-worker/core/titling.js';
import { OWNER_TITLING_WINDOW_MS, TITLING_RUN_TIMEOUT_SECONDS } from '@myco-server-worker/db/sessions/title-work.js';
import { RUN_OVERRUN_MARGIN_MS } from '@myco-server-worker/core/run-deadline.js';
import { TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { titlingParamsOf } from '@myco-server-worker/core/titling-params.js';
import { MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, MATERIAL_EXCERPT_CHARS, SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { dispatchTask, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { publishFixture, sqliteEnv, withHarness } from './helpers/fixtures.js';
import { failingStatement } from './helpers/store-faults.js';
import { documentTitlingMaterial } from '@myco-server-worker/content/titling-material.js';

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://deployment.example';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = 'sk-ant-TEST-SECRET-VALUE-9f3b';
const OAT = 'sk-ant-oat01-SUBSCRIPTION-TEST-TOKEN';

interface Launch { runId: string; timeoutSeconds: number; envVars: Record<string, string> }

function harness(opts: { bound?: boolean; refuse?: boolean } = {}) {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  const sealed = serverEnvFromBindings({ ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } as never);
  const env: ServerEnv = opts.bound === false ? sealed : withHarness(() => sealed, {
    launch: async (spec) => { if (opts.refuse) throw new Error('the runtime refused the launch'); launches.push(spec); },
  });
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  const session = (id: string, over: { endedAt?: number | null; agent?: string; branch?: string; project?: string } = {}) =>
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at)
                  VALUES (?, ?, 'm1', 'tok_1', ?, ?, ?, ?, ?, ?)`, [over.project ?? 'proj_1', id, NOW - 10_000, NOW, over.agent ?? 'claude-code', over.branch ?? 'main', NOW - 10_000, over.endedAt === undefined ? NOW : over.endedAt]);
  const prompt = (session: string, id: string, text: string | null, at: number, origin = 'user') =>
    e.sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at) SELECT project_id,event_id,session_id,token_id,'prompt','cli',json_object('promptId',prompt_id,'text',text,'origin',origin,'updatedAt',updated_at),content_hash,created_at,received_at FROM (SELECT 'proj_1' AS project_id,? AS session_id,? AS prompt_id,? AS event_id,? AS text,? AS origin,? AS content_hash,? AS created_at,? AS updated_at,'tok_1' AS token_id,? AS received_at)`, [session, id, `e_${id}`, text, origin, `h_${id}`, at, at, at]);
  const response = (session: string, promptId: string, id: string, text: string | null, at: number) =>
    e.sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at) SELECT project_id,event_id,session_id,token_id,'response','cli',json_object('responseId',response_id,'promptId',prompt_id,'text',text),content_hash,created_at,received_at FROM (SELECT 'proj_1' AS project_id,? AS session_id,? AS response_id,? AS prompt_id,? AS event_id,? AS text,? AS content_hash,? AS created_at,'tok_1' AS token_id,? AS received_at)`, [session, id, promptId, `e_${id}`, text, `h_${id}`, at, at]);
  const row = (id: string) => e.sqlite.query(`SELECT title, summary, titled_at, titled_by FROM sessions WHERE session_id = ?`).get(id) as { title: string | null; summary: string | null; titled_at: number | null; titled_by: string | null };
  const RUN_COLUMNS = `id, status, task, run_context, dispatch_spec, held_by, dispatched_by, agent_id, provider, model, error`;
  type RunRow = { id: string; status: string; task: string; run_context: string | null; dispatch_spec: string | null; held_by: string | null; dispatched_by: string | null; agent_id: string; provider: string | null; model: string | null; error: string | null };
  const runRow = (id: string) => e.sqlite.query(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ?`).get(id) as RunRow | null;
  const runRows = () => e.sqlite.query(`SELECT ${RUN_COLUMNS} FROM agent_runs ORDER BY COALESCE(queued_at, started_at), id`).all() as RunRow[];
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  // Queued events publish before titling reads the catalog.
  const convert = () => publishFixture({ sqlite: e.sqlite, serverEnv: env }, NOW);
  const title = async (id: string, now = NOW) => { await convert(); return titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN }); };
  const ask = async (id: string, now = NOW) => { await convert(); return titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN }, { mode: 'owner', by: 'mem_asker' }); };
  const material = async (id: string, mode: 'claim' | 'owner' = 'claim') => { await convert(); return documentTitlingMaterial(env, 'proj_1', id, mode); };
  return { ...e, env, launches, setting, session, prompt, response, row, runRow, runRows, secrets, title, ask, convert, material };
}

/** The same Deployment with the queue's own write refused, so a dispatch that has spent a claim fails after it. */
const queueRefusing = (env: ServerEnv) => {
  const fault = failingStatement(env.db, 'runs.queueRecordWrite', { error: () => new Error('the queue refused the write') });
  return { env: { ...env, db: fault.store }, failures: fault.failures };
};

const logged: string[] = [];
const originalLog = console.log;
beforeEach(() => { logged.length = 0; console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
afterEach(() => { console.log = originalLog; });

const seedAnthropic = async (h: ReturnType<typeof harness>, key = KEY) => {
  await h.secrets.put('anthropic', key, 'mem_1', NOW);
};
const untouched = { title: null, summary: null, titled_at: null, titled_by: null };

describe('titleSession', () => {
  it('defers a live end until its transcript is published, then the wake job claims it once', async () => {
    const h = harness();
    h.session('s1');
    h.prompt('s1', 'p1', 'first turn', NOW - 9_000);
    h.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset,
      first_received_at, last_received_at, token_id, fidelity) VALUES ('proj_1','tx1','s1','m',200,100,1,2,'t','full')`);
    h.sqlite.run(`INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES ('proj_1','end','s1','t','session.end','cli','{}','h',?,?)`, [NOW, NOW]);
    h.sqlite.run(`UPDATE sessions SET titling_requested_at = ? WHERE session_id = 's1'`, [NOW]);
    expect(await h.title('s1')).toEqual({ outcome: 'capture_pending' });
    expect(h.row('s1').titled_at).toBeNull();
    const env = { ...h.env, origin: ORIGIN };
    expect(await titleReadySessions(env, NOW)).toBe(0);
    expect(h.runRows()).toHaveLength(0);
    h.sqlite.run("UPDATE transcripts SET parsed_offset=size WHERE transcript_id='tx1'");
    h.sqlite.run("UPDATE session_documents SET due_at=0 WHERE session_id='s1'");
    await publishFixture({ sqlite: h.sqlite, serverEnv: h.env }, NOW);
    await expect(titleReadySessions({ ...h.env, origin: undefined }, NOW + SESSION_END_SETTLE_MS)).rejects.toThrow('Deployment origin');
    expect(await titleReadySessions(env, NOW + SESSION_END_SETTLE_MS + 1)).toBe(1);
    expect(h.runRows()).toHaveLength(1);
    expect(await titleReadySessions(env, NOW + SESSION_END_SETTLE_MS + 2)).toBe(0);
    expect(h.runRows()).toHaveLength(1);
  });

  it('does not automatically title imported session ends or sessions whose publication failed', async () => {
    const h = harness();
    for (const id of ['imported', 'historical', 'failed']) {
      h.session(id);
      h.prompt(id, `p_${id}`, 'material', NOW - 1_000);
      h.sqlite.run(`INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
        VALUES ('proj_1',?,?,'t','session.end',?,'{}','h',?,?)`, [`end_${id}`, id, id === 'imported' ? 'import' : 'cli', NOW, NOW]);
    }
    h.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset,
      first_received_at, last_received_at, token_id, parse_error) VALUES ('proj_1','tx','failed','m',100,100,1,2,'t','bad record')`);
    h.sqlite.run(`UPDATE sessions SET titling_requested_at = ? WHERE session_id = 'failed'`, [NOW]);
    await h.convert();
    expect(await titleReadySessions({ ...h.env, origin: ORIGIN }, NOW)).toBe(0);
    expect(h.runRows()).toHaveLength(0);
    expect((await h.ask('failed')).outcome).toBe('capture_pending');
    expect(h.row('failed').titled_at).toBeNull();
  });

  it('claims the session, queues one titling run carrying the whole dispatch, and skips every later attempt', async () => {
    const h = harness();
    await seedAnthropic(h, OAT);
    h.session('s1');
    h.prompt('s1', 'p1', 'Fix the flaky test in runner.ts', NOW - 9000);
    h.response('s1', 'p1', 'r1', 'Looking at runner.ts now.', NOW - 8500);

    // A worker claims this task from the queue, so the dispatch resolves no provider and opens no credential; the admission the claim is gated on is the capture-driven one.
    expect(await prepareDispatch(h.env, TITLING_TASK, 'proj_1')).toEqual({
      ok: true,
      prepared: { task: 'title-summary', projectId: 'proj_1', servedBy: 'worker', providerType: null, model: null, provider: {}, credentialEnv: {}, admission: 'captureDriven' },
    });

    const first = await h.title('s1');
    expect(first.outcome).toBe('queued');
    expect(h.launches).toHaveLength(0);
    expect(h.row('s1')).toEqual({ ...untouched, titled_at: NOW });
    // The run's row is the server's record of the dispatch: queued behind a worker, naming no provider and holding no credential while it waits.
    const run = h.runRow(first.runId!)!;
    expect({ status: run.status, task: run.task, agent: run.agent_id, held: run.held_by, credential: run.dispatched_by, provider: run.provider, model: run.model })
      .toEqual({ status: 'queued', task: 'title-summary', agent: 'myco-agent', held: 'worker', credential: null, provider: null, model: null });
    // The launch the dispatch asked for rides the row: where the run calls back, who it is attributed to, its bound, and the task's parameters.
    expect(JSON.parse(run.dispatch_spec ?? 'null')).toEqual({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS, params: { session_id: 's1', mode: 'claim' } });
    expect(logged.some((l) => l.includes('session_title_queued'))).toBe(true);
    expect(logged.some((l) => l.includes('harness_queued'))).toBe(true);

    expect((await h.title('s1')).outcome).toBe('already');
    expect(h.runRows()).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(OAT);
  });

  it('makes one attempt per session even when two ends race, none for a session that has not ended, and one run each for two sessions ending together', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p2', 'hello', NOW - 9000);
    await h.convert();
    const [a, b] = await Promise.all([h.title('s1'), h.title('s1')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already', 'queued']);
    expect(h.runRows()).toHaveLength(1);
    expect((await h.title('open')).outcome).toBe('already');
    expect(h.runRows()).toHaveLength(1);

    h.session('s2');
    h.prompt('s2', 'p3', 'hello', NOW - 9000);
    h.session('s3');
    h.prompt('s3', 'p4', 'hello', NOW - 9000);
    await h.convert();
    const [c, d] = await Promise.all([h.title('s2'), h.title('s3')]);
    expect([c.outcome, d.outcome]).toEqual(['queued', 'queued']);
    expect(h.runRows()).toHaveLength(3);
    expect(new Set(h.runRows().map((r) => r.id)).size).toBe(3);
  });

  it('queues and spends each session\'s claim without a bound runtime, in both modes', async () => {
    const h = harness({ bound: false });
    await seedAnthropic(h);
    for (const id of ['s1', 's2']) {
      h.session(id);
      h.prompt(id, `p_${id}`, 'hello', NOW - 9000);
    }
    expect((await h.title('s1')).outcome).toBe('queued');
    expect((await h.ask('s2')).outcome).toBe('queued');
    expect([h.row('s1'), h.row('s2')]).toEqual([{ ...untouched, titled_at: NOW }, { ...untouched, titled_at: NOW }]);
    expect(h.launches).toHaveLength(0);
    const waiting = { status: 'queued', task: 'title-summary', held: 'worker', credential: null };
    expect(h.runRows().map((r) => ({ status: r.status, task: r.task, held: r.held_by, credential: r.dispatched_by }))).toEqual([waiting, waiting]);
  });

  it('queues session titles independently of archived provider preferences', async () => {
    const h = harness();
    expect(await prepareDispatch(h.env, 'title-summary', 'proj_1')).toMatchObject({ ok: true, prepared: { servedBy: 'worker' } });

    // A titling dispatch names no provider at all, so none of those settings decides it: each ask queues and spends its session's claim.
    const sessions = ['unserved', 'none', 'uncredentialed', 'bad-model'];
    for (const id of sessions) {
      h.session(id);
      h.prompt(id, `p_${id}`, 'hello', NOW - 9000);
    }
    expect((await h.ask('unserved')).outcome).toBe('queued');
    expect((await h.title('none')).outcome).toBe('queued');
    expect((await h.title('uncredentialed')).outcome).toBe('queued');
    h.setting('agent.reasoning_map.claude-code.default', '!! invalid');
    expect((await h.title('bad-model')).outcome).toBe('queued');

    expect(sessions.map((id) => h.row(id))).toEqual(sessions.map(() => ({ ...untouched, titled_at: NOW })));
    expect(h.launches).toHaveLength(0);
    const unresolved = { held: 'worker', provider: null, model: null };
    expect(h.runRows().map((r) => ({ held: r.held_by, provider: r.provider, model: r.model }))).toEqual(sessions.map(() => unresolved));
  });

  it('queues nothing and stamps nothing for an empty session, and carries no endpoint or credential on the run it does queue', async () => {
    const h = harness();
    h.session('empty');
    expect((await h.title('empty')).outcome).toBe('no_material');
    expect((await h.ask('empty')).outcome).toBe('no_material');
    expect(h.row('empty')).toEqual(untouched);
    expect(h.runRows()).toHaveLength(0);

    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.prompt('s1', 'spilled', null, NOW - 9500);
    const queued = await h.title('s1');
    expect(queued.outcome).toBe('queued');
    const run = h.runRow(queued.runId!)!;
    expect({ provider: run.provider, model: run.model, credential: run.dispatched_by }).toEqual({ provider: null, model: null, credential: null });
    expect(JSON.parse(run.dispatch_spec ?? 'null')).toEqual({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS, params: { session_id: 's1', mode: 'claim' } });
  });

  it('reaches no runtime at all, gives the claim back when the queue refuses the write, and resolves rather than rejecting', async () => {
    const h = harness({ refuse: true });
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    // The runtime bound here refuses every launch. A titling dispatch attempts none, and queues past it.
    expect((await h.title('s1')).outcome).toBe('queued');
    expect(h.launches).toHaveLength(0);
    expect(h.runRows().map((r) => ({ status: r.status, error: r.error }))).toEqual([{ status: 'queued', error: null }]);

    // A claim the dispatch then cannot spend comes back: the stamp an owner's claim replaced is whole again, and an owner may ask afresh.
    h.session('s2');
    h.sqlite.run(`UPDATE sessions SET titled_at = ?, titled_by = 'mem_earlier' WHERE session_id = 's2'`, [NOW - 60_000]);
    h.prompt('s2', 'p2', 'hello', NOW - 9000);
    const refusing = queueRefusing(h.env);
    await h.convert();
    expect((await titleSession(refusing.env, { projectId: 'proj_1', sessionId: 's2', now: NOW + OWNER_TITLING_WINDOW_MS, origin: ORIGIN }, { mode: 'owner', by: 'mem_asker' })).outcome).toBe('error');
    expect(refusing.failures()).toBeGreaterThan(0);
    expect(h.row('s2')).toEqual({ ...untouched, titled_at: NOW - 60_000, titled_by: 'mem_earlier' });

    // The session's own attempt is untouched by the same refusal, and stays open.
    h.session('s3');
    h.prompt('s3', 'p3', 'hello', NOW - 9000);
    await h.convert();
    expect((await titleSession(refusing.env, { projectId: 'proj_1', sessionId: 's3', now: NOW, origin: ORIGIN })).outcome).toBe('error');
    expect(h.row('s3')).toEqual(untouched);
    expect(logged.filter((l) => l.includes('session_title_failed'))).toHaveLength(2);

    const broken = { ...h.env, db: { prepare: () => { throw new Error('store detached'); } } as never };
    expect((await titleSession(broken, { projectId: 'proj_1', sessionId: 's1', now: NOW, origin: ORIGIN })).outcome).toBe('error');
    expect(logged.some((l) => l.includes('"outcome":"error"'))).toBe(true);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('bounds the material by prompt count and by characters, and reads only inline user prompts with their first inline response', async () => {
    const h = harness();
    h.session('s1');
    for (let i = 0; i < MAX_MATERIAL_PROMPTS + 3; i += 1) {
      h.prompt('s1', `p${String(i).padStart(2, '0')}`, `prompt ${i} ${'x'.repeat(MATERIAL_EXCERPT_CHARS + 50)}`, NOW - 20_000 + i);
      if (i > 1) h.response('s1', `p${String(i).padStart(2, '0')}`, `r${i}`, `response ${i} ${'y'.repeat(MATERIAL_EXCERPT_CHARS + 50)}`, NOW - 20_000 + i);
    }
    h.response('s1', 'p00', 'r_late', 'later response', NOW - 19_000);
    h.response('s1', 'p00', 'r_first', 'first response', NOW - 19_500);
    h.response('s1', 'p01', 'r_spilled', null, NOW - 19_000);
    h.prompt('s1', 'p_sys', 'system preamble', NOW - 21_000, 'system');
    const material = await h.material('s1');
    expect(material.length).toBeLessThanOrEqual(MAX_MATERIAL_PROMPTS);
    expect(material.length).toBeGreaterThan(2);
    expect(material[0].prompt.length).toBe(MATERIAL_EXCERPT_CHARS);
    expect(material[0].response).toBe('first response');
    expect(material[1].response).toBeNull();
    expect(material[2].response?.length).toBe(MATERIAL_EXCERPT_CHARS);
    expect(material.some((m) => m.prompt.includes('system preamble'))).toBe(false);
    expect(material.reduce((n, m) => n + m.prompt.length + (m.response?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
  });

  it('accepts only a bounded title and summary from a run', () => {
    expect(cleanTitle('  Did the thing.  ')).toBe('Did the thing');
    expect(cleanTitle('Two\n lines')).toBe('Two lines');
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('t'.repeat(81))).toBeNull();
    expect(cleanSummary(' It worked. ')).toBe('It worked.');
    expect(cleanSummary('s'.repeat(1201))).toBeNull();
    expect(cleanSummary('   ')).toBeNull();
  });

  it('reads a titling dispatch back from a run\'s context, and nothing else', () => {
    expect(titlingParamsOf(JSON.stringify({ session_id: 's1', mode: 'owner' }))).toEqual({ session_id: 's1', mode: 'owner' });
    expect(titlingParamsOf(JSON.stringify({ session_id: 's1', mode: 'anything' }))).toBeNull();
    expect(titlingParamsOf(JSON.stringify({ mode: 'claim' }))).toBeNull();
    expect(titlingParamsOf('not json')).toBeNull();
    expect(titlingParamsOf(null)).toBeNull();
  });

  it('holds the owner window to the run\'s bound plus the margin the dispatcher allows past it', () => {
    expect(OWNER_TITLING_WINDOW_MS).toBe(TITLING_RUN_TIMEOUT_SECONDS * 1000 + RUN_OVERRUN_MARGIN_MS);
  });
});

describe('titleSession on an owner\'s ask', () => {
  it('dispatches for an open session, for a titled one, names who asked in the run\'s spec, and leaves the end-of-session claim spent', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p1', 'hello', NOW - 9000);
    const asked = await h.ask('open');
    expect(asked.outcome).toBe('queued');
    // The stamp is the claim; the ask is attributed to the member who made it, and the run carries their name through to the write.
    expect(h.row('open')).toEqual({ ...untouched, titled_at: NOW });
    expect(JSON.parse(h.runRow(asked.runId!)!.dispatch_spec ?? 'null'))
      .toEqual({ serverUrl: ORIGIN, actor: 'mem_asker', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS, params: { session_id: 'open', mode: 'owner', by: 'mem_asker' } });
    expect(logged.join('\n')).not.toContain(KEY);
    h.sqlite.run(`UPDATE sessions SET title = 'Old', summary = 'old' WHERE session_id = 'open'`);
    expect((await h.ask('open', NOW + OWNER_TITLING_WINDOW_MS + 1)).outcome).toBe('queued');
    expect(h.runRows()).toHaveLength(2);
    // The session's own end finds the claim spent and dispatches nothing.
    h.sqlite.run(`UPDATE sessions SET ended_at = ? WHERE session_id = 'open'`, [NOW + 40_000]);
    expect((await h.title('open')).outcome).toBe('already');
    expect(h.runRows()).toHaveLength(2);
  });

  it('refuses a second ask while the first run may still be writing, and admits one after the window', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.ask('s1')).outcome).toBe('queued');
    expect((await h.ask('s1', NOW + 1000)).outcome).toBe('already');
    expect((await h.ask('s1', NOW + OWNER_TITLING_WINDOW_MS - 1)).outcome).toBe('already');
    expect((await h.ask('s1', NOW + OWNER_TITLING_WINDOW_MS + 1)).outcome).toBe('queued');
    expect(h.runRows()).toHaveLength(2);
  });

  it('reads the opening and the closing prompts inside the budget, so the arc\'s end reaches the run', async () => {
    const h = harness();
    h.session('s1');
    const n = MAX_MATERIAL_PROMPTS + 6;
    for (let i = 0; i < n; i += 1) {
      const id = `p${String(i).padStart(2, '0')}`;
      h.prompt('s1', id, `prompt ${i} ${'x'.repeat(MATERIAL_EXCERPT_CHARS)}`, NOW - 20_000 + i);
      h.response('s1', id, `r${i}`, `response ${i} ${'y'.repeat(MATERIAL_EXCERPT_CHARS)}`, NOW - 20_000 + i);
    }
    const owner = await h.material('s1', 'owner');
    const claim = await h.material('s1', 'claim');
    expect(owner.reduce((c, m) => c + m.prompt.length + (m.response?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    expect(owner[0].prompt.startsWith('prompt 0 ')).toBe(true);
    expect(owner[owner.length - 1].prompt.startsWith(`prompt ${n - 1} `)).toBe(true);
    expect(claim[claim.length - 1].prompt.startsWith(`prompt ${n - 1} `)).toBe(false);
    // A short session reads each prompt once.
    h.session('s2');
    h.prompt('s2', 'q1', 'one', NOW - 9000);
    h.prompt('s2', 'q2', 'two', NOW - 8000);
    expect((await h.material('s2', 'owner')).map((m) => m.prompt)).toEqual(['one', 'two']);
  });
});


describe('direct session titles', () => {
  const answer = { title: 'Shipped bounded session titles', summary: 'Built direct session titling. Verified title and summary persistence.' };
  function direct(complete: CompletionProvider['complete'], opening = 'Read docs/task.md and do it.') {
    const h = harness({ bound: false });
    const pending: Promise<void>[] = [];
    h.env.completionProvider = async () => ({ model: '@cf/openai/gpt-oss-20b', complete });
    h.env.afterResponse = work => { pending.push(work()); };
    h.session('direct');
    h.prompt('direct', 'opening', opening, NOW - 8000);
    return { ...h, settle: () => Promise.all(pending) };
  }

  it('writes a validated title once, records model usage and estimated cost, and leaves later prompts uncovered', async () => {
    let calls = 0;
    const h = direct(async () => {
      calls++;
      h.prompt('direct', 'later', 'Also cover a new requirement', NOW + 1);
      await h.convert();
      return { text: JSON.stringify(answer), usage: { input: 1200, output: 80 } };
    });
    const run = await h.title('direct');
    expect(run.outcome).toBe('dispatched');
    await h.settle();
    expect((await h.title('direct', NOW + 2)).outcome).toBe('already');
    expect(calls).toBe(1);
    expect(h.row('direct')).toMatchObject(answer);
    expect(h.runRow(run.runId!)).toMatchObject({ status: 'completed', model: '@cf/openai/gpt-oss-20b', provider: 'direct' });
    const persisted = h.sqlite.query('SELECT tokens_used,cost_usd,cost_source FROM agent_runs WHERE id=?').get(run.runId!) as { tokens_used: number; cost_usd: number; cost_source: string };
    expect(persisted.tokens_used).toBe(1280);
    expect(persisted.cost_usd).toBeGreaterThan(0);
    expect(persisted.cost_source).toBe('catalogue_estimate');
    const coverage = h.sqlite.query('SELECT user_prompts,titled_user_prompts FROM session_documents WHERE session_id=?').get('direct');
    expect(coverage).toEqual({ user_prompts: 2, titled_user_prompts: 1 });
    h.sqlite.close();
  });

  it('retries an invalid answer once, stores a named failure after two, then remains eligible', async () => {
    let valid = false;
    const h = direct(async () => ({ text: valid ? JSON.stringify(answer) : '{"title":"bad"}', usage: { input: 40, output: 10 } }));
    const first = await h.title('direct');
    await h.settle();
    expect(h.row('direct')).toEqual({ ...untouched, titled_at: NOW });
    expect(h.runRow(first.runId!)).toMatchObject({ status: 'failed', error: 'completion_invalid_answer' });
    valid = true;
    expect((await h.title('direct', NOW + 1)).outcome).toBe('already');
    const next = await titleSession(h.env, { projectId: 'proj_1', sessionId: 'direct', now: NOW + OWNER_TITLING_WINDOW_MS + 1, origin: ORIGIN }, { retry: true });
    await h.settle();
    expect(next.outcome).toBe('dispatched');
    expect(h.row('direct')).toMatchObject(answer);
    h.sqlite.close();
  });

  it('protects the provider across retries and leaves rate-limited sessions eligible', async () => {
    let calls = 0;
    const h = direct(async () => { calls++; return { text: JSON.stringify(answer), usage: null }; });
    for (let i = 0; i <= DIRECT_CALLS_PER_MINUTE; i++) {
      const id = 'rate-' + i; h.session(id); h.prompt(id, 'prompt-' + i, 'Title this work', NOW - 1);
      await h.title(id, NOW + i); await h.settle();
    }
    expect(calls).toBe(DIRECT_CALLS_PER_MINUTE);
    expect(h.runRows().some(run => run.error === 'completion_rate_limited')).toBe(true);
    expect(h.row('rate-' + DIRECT_CALLS_PER_MINUTE)).toEqual(untouched);
    expect(await h.ask('direct', NOW + 30_000)).toMatchObject({ outcome: 'error' });
    expect(h.row('direct')).toEqual(untouched);
    expect(await h.ask('direct', NOW + 90_001)).toMatchObject({ outcome: 'completed', ...answer });
    h.sqlite.close();
  });


  it('bounds repeated failures over ticks and titles a healthy session behind failing ones', async () => {
    let calls = 0;
    const h = direct(async request => {
      calls++;
      return { text: request.messages[1]!.content.includes('poison') ? '{}' : JSON.stringify(answer), usage: { input: 40, output: 10 } };
    });
    for (let i = 0; i < 5; i++) { h.session('poison-' + i, { endedAt: NOW + i + 1 }); h.prompt('poison-' + i, 'bad-' + i, 'poison', NOW - 100); }
    await h.convert();
    for (const at of [NOW + 10, NOW + 61_010, NOW + OWNER_TITLING_WINDOW_MS + 61_010, NOW + 2 * OWNER_TITLING_WINDOW_MS + 122_010]) {
      await backfillTitles(h.env, at, 'active'); await h.settle();
    }
    expect(h.row('direct')).toMatchObject(answer);
    const attempts = h.sqlite.query('SELECT titling_attempts FROM sessions WHERE session_id=?').get('poison-0') as { titling_attempts: number };
    expect(attempts.titling_attempts).toBe(TITLING_MAX_ATTEMPTS);
    expect(calls).toBeLessThanOrEqual(5 * TITLING_MAX_ATTEMPTS * COMPLETION_ATTEMPTS + 1);
    const spent = calls;
    await backfillTitles(h.env, NOW + 4 * OWNER_TITLING_WINDOW_MS, 'active'); await h.settle();
    expect(calls).toBe(spent);
    h.sqlite.close();
  });

  it('gives back an attempt the provider failed, waits longer after each fault, and titles the session once the provider answers', async () => {
    let down = true, calls = 0;
    const h = direct(async () => {
      calls++;
      if (down) throw new CompletionUnavailable('timeout');
      return { text: JSON.stringify(answer), usage: { input: 40, output: 10 } };
    });
    await h.convert();
    const attempts = () => (h.sqlite.query('SELECT titling_attempts FROM sessions WHERE session_id=?').get('direct') as { titling_attempts: number }).titling_attempts;
    const MINUTE = 60_000;
    for (let tick = 0; tick < 40; tick++) { await backfillTitles(h.env, NOW + 10 + MINUTE * tick, 'active'); await h.settle(); }
    // Forty minutes of outage: far more than three tries, each later than the last, and none of them spent.
    expect(calls).toBeGreaterThan(TITLING_MAX_ATTEMPTS);
    expect(calls).toBeLessThan(40 * MINUTE / OWNER_TITLING_WINDOW_MS);
    expect(h.runRows().every(run => run.status === 'failed' && run.error === 'completion_timeout')).toBe(true);
    expect(attempts()).toBe(0);
    expect(h.row('direct')).toEqual(untouched);
    down = false;
    for (let tick = 40; tick < 130; tick++) { await backfillTitles(h.env, NOW + 10 + MINUTE * tick, 'active'); await h.settle(); }
    expect(h.row('direct')).toMatchObject(answer);
    expect(attempts()).toBe(1);
    h.sqlite.close();
  });

  it('bounds unreadable material attempts and titles an older healthy session behind them', async () => {
    let calls = 0;
    const h = direct(async () => { calls++; return { text: JSON.stringify(answer), usage: null }; });
    await h.convert();
    const readable = new Set(h.bucket.objects.keys());
    const broken = Array.from({ length: 30 }, (_, i) => 'broken-' + i);
    for (const [i, id] of broken.entries()) {
      h.session(id, { endedAt: NOW + i + 1 });
      h.prompt(id, 'prompt-' + id, 'Unreadable work ' + i, NOW - 100 + i);
    }
    await h.convert();
    h.env.blobs = { ...h.env.blobs, get: async (key, options) => {
      if (!readable.has(key)) throw new Error('document storage unavailable');
      return h.bucket.get(key, options);
    } };
    for (let tick = 0; tick < 60; tick++) {
      await backfillTitles(h.env, NOW + 60_000 * tick, 'idle'); await h.settle();
    }
    expect(h.row('direct')).toMatchObject(answer);
    expect(calls).toBe(1);
    expect(h.runRows().filter(run => run.error === 'title_material_or_write_failed').length).toBeLessThanOrEqual(broken.length * TITLING_MAX_ATTEMPTS);
    for (const id of broken) {
      const row = h.sqlite.query('SELECT titling_attempts FROM sessions WHERE session_id=?').get(id) as { titling_attempts: number };
      expect(row.titling_attempts).toBe(TITLING_MAX_ATTEMPTS);
    }
    h.sqlite.close();
  });

  it('closes abandoned direct work without reserving runner capacity', async () => {
    const h = direct(async () => { throw new Error('not called'); });
    h.env.afterResponse = () => {};
    const run = await h.title('direct');
    expect(await dispatchLoad(h.env.db, TITLING_TASK, NOW)).toMatchObject({ liveRuns: 0, liveTaskRuns: 0, taskRunsLastHour: 0 });
    await runStaleSweep(h.env, NOW + DIRECT_TITLE_BUDGET_MS + DIRECT_TITLE_SETTLEMENT_MS + 1);
    expect(h.runRow(run.runId!)).toMatchObject({ status: 'failed', error: 'The direct model call did not settle before its deadline' });
    const retry = await titleSession(h.env, { projectId: 'proj_1', sessionId: 'direct', now: NOW + OWNER_TITLING_WINDOW_MS + 1, origin: ORIGIN }, { retry: true });
    expect(retry.outcome).toBe('dispatched');
    h.sqlite.close();
  });

  it('does not send archived project material to a provider', async () => {
    let calls = 0;
    const h = direct(async () => { calls++; return { text: JSON.stringify(answer), usage: null }; });
    h.sqlite.run('UPDATE projects SET archived_at=? WHERE project_id=?', [NOW, 'proj_1']);
    expect((await h.title('direct')).outcome).toBe('error');
    await h.settle();
    expect(calls).toBe(0);
    expect(h.runRows()).toEqual([]);
    h.sqlite.close();
  });

  it('retains known spend when a validation retry cannot report usage', async () => {
    let calls = 0;
    const h = direct(async () => {
      if (calls++ > 0) throw new CompletionUnavailable('unreachable');
      return { text: '{}', usage: { input: 100, output: 20 } };
    });
    const run = await h.title('direct'); await h.settle();
    const observed = h.sqlite.query('SELECT tokens_used,cost_usd,cost_source FROM agent_runs WHERE id=?').get(run.runId!) as { tokens_used: number; cost_usd: number; cost_source: string };
    expect(observed.tokens_used).toBe(120);
    expect(observed.cost_usd).toBeGreaterThan(0);
    expect(observed.cost_source).toBe('partial');
    h.sqlite.close();
  });

  it.each([['Read docs/task.md and do it.', 'docs/task.md'], ['Read @docs/task.md.', 'docs/task.md'], ['Fix the Makefile', 'Makefile']])('uses captured reads for %s, with head, tail and closing replies', async (opening, file) => {
    const h = direct(async () => ({ text: JSON.stringify(answer), usage: null }), opening);
    h.sqlite.run("INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at) VALUES('proj_1','read-task','direct','tok_1','tool.use','cli',?,'hash',?,?)",
      [JSON.stringify({ toolCallId: 'read-task', promptId: 'opening', toolName: 'Read', input: { file_path: `/work/${file}` }, output: 'Build direct session titles with bounded calls.', success: true }), NOW - 7900, NOW - 7900]);
    for (const [id, toolName, input] of [['shell', 'Bash', { command: 'env | head' }], ['unrelated', 'Read', { file_path: '/work/docs/other-task.md' }]] as const) {
      h.sqlite.run("INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at) VALUES('proj_1',?,'direct','tok_1','tool.use','cli',?,'hash',?,?)",
        [id, JSON.stringify({ toolCallId: id, promptId: 'opening', toolName, input, output: 'DO NOT SEND UNRELATED OUTPUT', success: true }), NOW - 7950, NOW - 7950]);
    }
    for (let i = 0; i < 14; i++) {
      h.prompt('direct', 'turn-' + i, 'Human requirement ' + i, NOW - 7000 + i * 10);
      h.response('direct', 'turn-' + i, 'early-' + i, 'I will investigate.', NOW - 6999 + i * 10);
      h.response('direct', 'turn-' + i, 'closing-' + i, 'Completed requirement ' + i, NOW - 6998 + i * 10);
    }
    h.prompt('direct', 'notice', 'DO NOT TREAT AS HUMAN', NOW - 1, 'system');
    await h.convert();
    const material = await singleTurnMaterial(h.env, 'proj_1', 'direct');
    expect(material.text).toContain('Human requirement 13');
    expect(material.text).toContain('Completed requirement 13');
    expect(material.text).toContain('Build direct session titles');
    expect(material.text).not.toContain('DO NOT TREAT AS HUMAN');
    expect(material.text).not.toContain('DO NOT SEND UNRELATED OUTPUT');
    expect(material.text.length).toBeLessThanOrEqual(10000);
    h.sqlite.close();
  });
});
