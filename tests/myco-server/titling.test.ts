/**
 * The titling gate: one harness dispatch per ended session, queued for a worker
 * to claim, with the queued row carrying the whole launch the dispatch asked for
 * and no credential at all, and nothing of the Deployment's secrets in telemetry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import {
  cleanSummary, cleanTitle, OWNER_TITLING_WINDOW_MS, RUN_OVERRUN_MARGIN_MS, sessionMaterial, titleSession, titleReadySessions, TITLING_RUN_TIMEOUT_SECONDS, TITLING_TASK, titlingParamsOf,
} from '@myco-server-worker/core/titling.js';
import { MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, MATERIAL_EXCERPT_CHARS } from '@myco-server-worker/constants.js';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { dispatchTask, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { sqliteEnv, withHarness } from './helpers/fixtures.js';

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
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, ?, ?, ?, ?, ?, 'tok_1', ?)`, [session, id, `e_${id}`, text, origin, `h_${id}`, at, at, at]);
  const response = (session: string, promptId: string, id: string, text: string | null, at: number) =>
    e.sqlite.run(`INSERT INTO responses (project_id, session_id, response_id, prompt_id, event_id, text, content_hash, created_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, ?, ?, ?, ?, 'tok_1', ?)`, [session, id, promptId, `e_${id}`, text, `h_${id}`, at, at]);
  const row = (id: string) => e.sqlite.query(`SELECT title, summary, titled_at, titled_by FROM sessions WHERE session_id = ?`).get(id) as { title: string | null; summary: string | null; titled_at: number | null; titled_by: string | null };
  const RUN_COLUMNS = `id, status, task, run_context, dispatch_spec, held_by, dispatched_by, agent_id, provider, model, error`;
  type RunRow = { id: string; status: string; task: string; run_context: string | null; dispatch_spec: string | null; held_by: string | null; dispatched_by: string | null; agent_id: string; provider: string | null; model: string | null; error: string | null };
  const runRow = (id: string) => e.sqlite.query(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ?`).get(id) as RunRow | null;
  const runRows = () => e.sqlite.query(`SELECT ${RUN_COLUMNS} FROM agent_runs ORDER BY COALESCE(queued_at, started_at), id`).all() as RunRow[];
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  const title = (id: string, now = NOW) => titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN });
  const ask = (id: string, now = NOW) => titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN }, { mode: 'owner', by: 'mem_asker' });
  return { ...e, env, launches, setting, session, prompt, response, row, runRow, runRows, secrets, title, ask };
}

/** The same Deployment with the queue's own write refused, so a dispatch that has spent a claim fails after it. */
const queueRefusing = (env: ServerEnv): ServerEnv => {
  const db: RelationalStore = {
    prepare: (sql: string) => {
      if (sql.includes('INSERT INTO agent_runs')) throw new Error('the queue refused the write');
      return env.db.prepare(sql);
    },
    batch: (statements) => env.db.batch(statements),
  };
  return { ...env, db };
};

const logged: string[] = [];
const originalLog = console.log;
beforeEach(() => { logged.length = 0; console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
afterEach(() => { console.log = originalLog; });

const seedAnthropic = async (h: ReturnType<typeof harness>, key = KEY) => {
  h.setting('agent.provider.type', 'anthropic');
  await h.secrets.put('anthropic', key, 'mem_1', NOW);
};
const untouched = { title: null, summary: null, titled_at: null, titled_by: null };

describe('titleSession', () => {
  it('defers a live end until its second turn is parsed, then the wake job claims it once', async () => {
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
    await expect(sessionMaterial(h.db, 'proj_1', 's1')).rejects.toThrow('capture is incomplete');
    const env = { ...h.env, origin: ORIGIN };
    expect(await titleReadySessions(env, NOW)).toBe(0);
    expect(h.runRows()).toHaveLength(0);
    h.prompt('s1', 'p2', 'second turn correction', NOW - 1_000);
    h.sqlite.run(`UPDATE transcripts SET parsed_offset = size WHERE transcript_id = 'tx1'`);
    await expect(titleReadySessions({ ...h.env, origin: undefined }, NOW)).rejects.toThrow('Deployment origin');
    expect(await titleReadySessions(env, NOW + 1)).toBe(1);
    expect(h.runRows()).toHaveLength(1);
    expect((await sessionMaterial(h.db, 'proj_1', 's1')).map((p) => p.prompt)).toEqual(['first turn', 'second turn correction']);
    expect(await titleReadySessions(env, NOW + 2)).toBe(0);
    expect(h.runRows()).toHaveLength(1);
  });

  it('does not automatically title imported session ends or sessions with failed parsing', async () => {
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

  it('hands an API key under its own variable, and the task override for provider and model ahead of the defaults, on a runtime-served launch', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.setting('agent.provider.model', 'claude-default');
    h.setting('agent.tasks', { 'container-smoke': { provider: 'anthropic', model: 'claude-for-titles' } });
    expect(await dispatchTask(h.env, 'container-smoke', 'proj_1', { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 }, NOW)).toMatchObject({ dispatched: true, queued: false });
    const vars = h.launches[0]!.envVars;
    expect({ apiKey: vars.ANTHROPIC_API_KEY, model: vars.MYCO_MODEL }).toEqual({ apiKey: KEY, model: 'claude-for-titles' });
    expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic', model: 'claude-for-titles' });
    expect(logged.join('\n')).not.toContain(KEY);

    // A titling dispatch reads none of it: the harness that runs the run, and the credential that harness reads, are the worker's to resolve at the claim.
    h.setting('agent.tasks', { 'title-summary': { provider: 'anthropic', model: 'claude-for-titles' } });
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    const titling = await h.title('s1');
    expect(titling.outcome).toBe('queued');
    const queued = h.runRow(titling.runId!)!;
    expect({ provider: queued.provider, model: queued.model, credential: queued.dispatched_by }).toEqual({ provider: null, model: null, credential: null });
    expect(h.launches).toHaveLength(1);
  });

  it('makes one attempt per session even when two ends race, none for a session that has not ended, and one run each for two sessions ending together', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p2', 'hello', NOW - 9000);
    const [a, b] = await Promise.all([h.title('s1'), h.title('s1')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already', 'queued']);
    expect(h.runRows()).toHaveLength(1);
    expect((await h.title('open')).outcome).toBe('already');
    expect(h.runRows()).toHaveLength(1);

    h.session('s2');
    h.prompt('s2', 'p3', 'hello', NOW - 9000);
    h.session('s3');
    h.prompt('s3', 'p4', 'hello', NOW - 9000);
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

  it('queues and spends the claim with no provider, no credential, an unserved provider, or an endpoint provider with no endpoint — and refuses each for a runtime-served task', async () => {
    const h = harness();
    // The three refusals the launch seam still answers, on the task the seam still serves.
    expect(await prepareDispatch(h.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'no_provider' });
    h.setting('agent.provider.type', 'anthropic');
    expect(await prepareDispatch(h.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'no_credential' });
    h.setting('agent.provider.type', 'openai-compatible');
    expect(await prepareDispatch(h.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'no_endpoint' });
    h.setting('agent.provider.type', 'openrouter');
    expect(await prepareDispatch(h.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'unsupported_provider', providerType: 'openrouter' });

    // A titling dispatch names no provider at all, so none of those settings decides it: each ask queues and spends its session's claim.
    const sessions = ['unserved', 'none', 'uncredentialed', 'endpointless'];
    for (const id of sessions) {
      h.session(id);
      h.prompt(id, `p_${id}`, 'hello', NOW - 9000);
    }
    expect((await h.ask('unserved')).outcome).toBe('queued');
    h.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'agent.provider.type'`);
    expect((await h.title('none')).outcome).toBe('queued');
    h.setting('agent.provider.type', 'anthropic');
    expect((await h.title('uncredentialed')).outcome).toBe('queued');
    h.setting('agent.provider.type', 'openai-compatible');
    expect((await h.title('endpointless')).outcome).toBe('queued');

    expect(sessions.map((id) => h.row(id))).toEqual(sessions.map(() => ({ ...untouched, titled_at: NOW })));
    expect(h.launches).toHaveLength(0);
    const unresolved = { held: 'worker', provider: null, model: null };
    expect(h.runRows().map((r) => ({ held: r.held_by, provider: r.provider, model: r.model }))).toEqual(sessions.map(() => unresolved));
  });

  it('queues nothing and stamps nothing for an empty session, and carries no endpoint or credential on the run it does queue', async () => {
    const h = harness();
    h.setting('agent.provider.type', 'openai-compatible');
    h.setting('agent.provider.model', 'local-model');
    h.setting('agent.provider.base_url', 'http://models.internal/v1');
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
    expect((await titleSession(refusing, { projectId: 'proj_1', sessionId: 's2', now: NOW + OWNER_TITLING_WINDOW_MS, origin: ORIGIN }, { mode: 'owner', by: 'mem_asker' })).outcome).toBe('error');
    expect(h.row('s2')).toEqual({ ...untouched, titled_at: NOW - 60_000, titled_by: 'mem_earlier' });

    // The session's own attempt is untouched by the same refusal, and stays open.
    h.session('s3');
    h.prompt('s3', 'p3', 'hello', NOW - 9000);
    expect((await titleSession(refusing, { projectId: 'proj_1', sessionId: 's3', now: NOW, origin: ORIGIN })).outcome).toBe('error');
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
    const material = await sessionMaterial(h.env.db, 'proj_1', 's1');
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
    const owner = await sessionMaterial(h.env.db, 'proj_1', 's1', 'owner');
    const claim = await sessionMaterial(h.env.db, 'proj_1', 's1', 'claim');
    expect(owner.reduce((c, m) => c + m.prompt.length + (m.response?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    expect(owner[0].prompt.startsWith('prompt 0 ')).toBe(true);
    expect(owner[owner.length - 1].prompt.startsWith(`prompt ${n - 1} `)).toBe(true);
    expect(claim[claim.length - 1].prompt.startsWith(`prompt ${n - 1} `)).toBe(false);
    // A short session reads each prompt once.
    h.session('s2');
    h.prompt('s2', 'q1', 'one', NOW - 9000);
    h.prompt('s2', 'q2', 'two', NOW - 8000);
    expect((await sessionMaterial(h.env.db, 'proj_1', 's2', 'owner')).map((m) => m.prompt)).toEqual(['one', 'two']);
  });
});
