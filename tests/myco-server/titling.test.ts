/**
 * The titling gate: one harness dispatch per ended session, claimed only after
 * every refusal is ruled out, with the credential travelling only into the
 * launched runtime's environment and never into telemetry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { HOLD_OVERRUN_MARGIN_MS } from '@myco-server-worker/platform/cloudflare/run-hold.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import {
  cleanSummary, cleanTitle, OWNER_TITLING_WINDOW_MS, RUN_OVERRUN_MARGIN_MS, sessionMaterial, titleSession, TITLING_RUN_TIMEOUT_SECONDS, titlingParamsOf,
} from '@myco-server-worker/core/titling.js';
import { MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, MATERIAL_EXCERPT_CHARS } from '@myco-server-worker/constants.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { LAUNCH_REFUSED_ERROR } from '@myco-server-worker/core/harness.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://deployment.example';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = 'sk-ant-TEST-SECRET-VALUE-9f3b';
const OAT = 'sk-ant-oat01-SUBSCRIPTION-TEST-TOKEN';

interface Launch { runId: string; timeoutSeconds: number; envVars: Record<string, string> }

function harness(opts: { bound?: boolean; refuse?: boolean } = {}) {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  const HARNESS = opts.bound === false ? undefined : {
    idFromName: (name: string) => ({ name }),
    get: () => ({ launch: async (spec: Launch) => { if (opts.refuse) throw new Error('container refused to start'); launches.push(spec); } }),
  };
  const env: ServerEnv = serverEnvFromBindings({ ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY }, ...(HARNESS === undefined ? {} : { HARNESS }) } as never);
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
  const runRow = (id: string) => e.sqlite.query(`SELECT status, task, run_context, dispatched_by, agent_id, error FROM agent_runs WHERE id = ?`).get(id) as { status: string; task: string; run_context: string | null; dispatched_by: string | null; agent_id: string; error: string | null } | null;
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  const title = (id: string, now = NOW) => titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN });
  const ask = (id: string, now = NOW) => titleSession(env, { projectId: 'proj_1', sessionId: id, now, origin: ORIGIN }, { mode: 'owner', by: 'mem_asker' });
  return { ...e, env, launches, setting, session, prompt, response, row, runRow, secrets, title, ask };
}

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
  it('claims the session, launches one titling run with the dispatch as environment, and skips every later attempt without a launch', async () => {
    const h = harness();
    await seedAnthropic(h, OAT);
    h.session('s1');
    h.prompt('s1', 'p1', 'Fix the flaky test in runner.ts', NOW - 9000);
    h.response('s1', 'p1', 'r1', 'Looking at runner.ts now.', NOW - 8500);

    const first = await h.title('s1');
    expect(first.outcome).toBe('dispatched');
    expect(h.launches).toHaveLength(1);
    const [launch] = h.launches;
    expect(launch.runId).toBe(first.runId!);
    expect(launch.timeoutSeconds).toBe(TITLING_RUN_TIMEOUT_SECONDS);
    const vars = launch.envVars;
    expect({ task: vars.MYCO_TASK, url: vars.MYCO_SERVER_URL, project: vars.MYCO_PROJECT, run: vars.MYCO_RUN_ID, admission: vars.MYCO_TASK_ADMISSION, oat: vars.CLAUDE_CODE_OAUTH_TOKEN, apiKey: vars.ANTHROPIC_API_KEY, timeout: vars.MYCO_TIMEOUT_SECONDS })
      .toEqual({ task: 'title-summary', url: ORIGIN, project: 'proj_1', run: first.runId, admission: 'captureDriven', oat: OAT, apiKey: undefined, timeout: String(TITLING_RUN_TIMEOUT_SECONDS) });
    expect(JSON.parse(vars.MYCO_TASK_PARAMS!)).toEqual({ session_id: 's1', mode: 'claim', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS });
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic' });
    expect(vars.MYCO_MEMBER_TOKEN.length).toBeGreaterThan(20);
    expect(h.row('s1')).toEqual({ ...untouched, titled_at: NOW });
    // The run's row is the server's record of the dispatch, written before the launch: pending, with the parameters as its context, attributed to the minted credential.
    const run = h.runRow(first.runId!);
    expect({ status: run?.status, task: run?.task, agent: run?.agent_id, context: JSON.parse(run?.run_context ?? 'null') }).toEqual({ status: 'pending', task: 'title-summary', agent: 'myco-agent', context: { session_id: 's1', mode: 'claim', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS } });
    expect(h.sqlite.query(`SELECT member_id FROM member_credentials WHERE id = ?`).get(run!.dispatched_by!)).toEqual({ member_id: 'mem_harness' });
    expect(logged.some((l) => l.includes('session_title_dispatched'))).toBe(true);
    expect(logged.some((l) => l.includes('harness_dispatch'))).toBe(true);

    expect((await h.title('s1')).outcome).toBe('already');
    expect(h.launches).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(OAT);
    expect(logged.join('\n')).not.toContain(vars.MYCO_MEMBER_TOKEN);
  });

  it('hands an API key under its own variable, and the task override for provider and model ahead of the defaults', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.setting('agent.provider.model', 'claude-default');
    h.setting('agent.tasks', { 'title-summary': { provider: 'anthropic', model: 'claude-for-titles' } });
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.title('s1')).outcome).toBe('dispatched');
    const vars = h.launches[0]!.envVars;
    expect({ apiKey: vars.ANTHROPIC_API_KEY, oat: vars.CLAUDE_CODE_OAUTH_TOKEN, model: vars.MYCO_MODEL }).toEqual({ apiKey: KEY, oat: undefined, model: 'claude-for-titles' });
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic', model: 'claude-for-titles' });
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('makes one attempt per session even when two ends race, none for a session that has not ended, and one run each for two sessions ending together', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p2', 'hello', NOW - 9000);
    const [a, b] = await Promise.all([h.title('s1'), h.title('s1')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already', 'dispatched']);
    expect(h.launches).toHaveLength(1);
    expect((await h.title('open')).outcome).toBe('already');
    expect(h.launches).toHaveLength(1);

    h.session('s2');
    h.prompt('s2', 'p3', 'hello', NOW - 9000);
    h.session('s3');
    h.prompt('s3', 'p4', 'hello', NOW - 9000);
    const [c, d] = await Promise.all([h.title('s2'), h.title('s3')]);
    expect([c.outcome, d.outcome]).toEqual(['dispatched', 'dispatched']);
    expect(h.launches).toHaveLength(3);
    expect(new Set(h.launches.map((l) => l.runId)).size).toBe(3);
  });

  it('launches nothing and stamps nothing without a bound runtime, in both modes', async () => {
    const h = harness({ bound: false });
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.title('s1')).outcome).toBe('harness_unavailable');
    expect((await h.ask('s1')).outcome).toBe('harness_unavailable');
    expect(h.row('s1')).toEqual(untouched);
    expect(h.launches).toHaveLength(0);
    expect(logged.filter((l) => l.includes('session_title_skipped') && l.includes('harness_unavailable'))).toHaveLength(2);
  });

  it('launches nothing and stamps nothing without a provider, without its credential, for a provider the dispatcher does not serve, or for an endpoint provider with no endpoint', async () => {
    const h = harness();
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.title('s1')).outcome).toBe('no_provider');
    expect((await h.ask('s1')).outcome).toBe('no_provider');

    h.setting('agent.provider.type', 'anthropic');
    expect((await h.title('s1')).outcome).toBe('no_credential');

    h.setting('agent.provider.type', 'ollama');
    h.setting('agent.provider.model', 'llama3');
    expect((await h.title('s1')).outcome).toBe('unsupported_provider');
    h.setting('agent.provider.type', 'openrouter');
    expect((await h.ask('s1')).outcome).toBe('unsupported_provider');

    h.setting('agent.provider.type', 'openai-compatible');
    expect((await h.title('s1')).outcome).toBe('no_endpoint');

    expect(h.row('s1')).toEqual(untouched);
    expect(h.launches).toHaveLength(0);
  });

  it('launches nothing and stamps nothing for an empty session, and reaches an openai-compatible endpoint without a credential', async () => {
    const h = harness();
    h.setting('agent.provider.type', 'openai-compatible');
    h.setting('agent.provider.model', 'local-model');
    h.setting('agent.provider.base_url', 'http://models.internal/v1');
    h.session('empty');
    expect((await h.title('empty')).outcome).toBe('no_material');
    expect((await h.ask('empty')).outcome).toBe('no_material');
    expect(h.row('empty')).toEqual(untouched);

    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.prompt('s1', 'spilled', null, NOW - 9500);
    expect((await h.title('s1')).outcome).toBe('dispatched');
    const vars = h.launches[0]!.envVars;
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'openai-compatible', model: 'local-model', baseUrl: 'http://models.internal/v1' });
    expect({ apiKey: vars.ANTHROPIC_API_KEY, oat: vars.CLAUDE_CODE_OAUTH_TOKEN }).toEqual({ apiKey: undefined, oat: undefined });
  });

  it('gives the claim back when the runtime refuses to launch, in both modes, and resolves rather than rejecting', async () => {
    const h = harness({ refuse: true });
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.title('s1')).outcome).toBe('error');
    expect(h.row('s1')).toEqual(untouched);
    // The dispatch's row records the refusal, in the runtime's own words, rather than sitting pending forever.
    const failedRows = h.sqlite.query(`SELECT status, error FROM agent_runs`).all() as Array<{ status: string; error: string | null }>;
    expect(failedRows).toEqual([{ status: 'failed', error: `${LAUNCH_REFUSED_ERROR}: container refused to start` }]);
    // The session's own attempt is still open, and an owner may ask at once.
    expect((await h.ask('s1')).outcome).toBe('error');
    expect(h.row('s1')).toEqual(untouched);
    // A stamp an owner's claim replaced comes back whole.
    h.session('s2');
    h.sqlite.run(`UPDATE sessions SET titled_at = ?, titled_by = 'mem_earlier' WHERE session_id = 's2'`, [NOW - 60_000]);
    h.prompt('s2', 'p2', 'hello', NOW - 9000);
    expect((await h.ask('s2', NOW + OWNER_TITLING_WINDOW_MS)).outcome).toBe('error');
    expect(h.row('s2')).toEqual({ ...untouched, titled_at: NOW - 60_000, titled_by: 'mem_earlier' });
    expect(logged.filter((l) => l.includes('session_title_failed'))).toHaveLength(3);

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

  it('holds the owner window to the run\'s bound plus the margin the hosted runtime holds a container past it', () => {
    expect(RUN_OVERRUN_MARGIN_MS).toBe(HOLD_OVERRUN_MARGIN_MS);
    expect(OWNER_TITLING_WINDOW_MS).toBe(TITLING_RUN_TIMEOUT_SECONDS * 1000 + HOLD_OVERRUN_MARGIN_MS);
  });
});

describe('titleSession on an owner\'s ask', () => {
  it('dispatches for an open session, for a titled one, names who asked in the run\'s context, and leaves the end-of-session claim spent', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p1', 'hello', NOW - 9000);
    const asked = await h.ask('open');
    expect(asked.outcome).toBe('dispatched');
    // The stamp is the claim; who wrote the title is stamped by the write, from the context the server recorded.
    expect(h.row('open')).toEqual({ ...untouched, titled_at: NOW });
    expect(JSON.parse(h.launches[0]!.envVars.MYCO_TASK_PARAMS!)).toEqual({ session_id: 'open', mode: 'owner', by: 'mem_asker', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS });
    expect(JSON.parse(h.runRow(asked.runId!)!.run_context!)).toEqual({ session_id: 'open', mode: 'owner', by: 'mem_asker', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS });
    expect(logged.join('\n')).not.toContain(KEY);
    h.sqlite.run(`UPDATE sessions SET title = 'Old', summary = 'old' WHERE session_id = 'open'`);
    expect((await h.ask('open', NOW + OWNER_TITLING_WINDOW_MS + 1)).outcome).toBe('dispatched');
    expect(h.launches).toHaveLength(2);
    // The session's own end finds the claim spent and launches nothing.
    h.sqlite.run(`UPDATE sessions SET ended_at = ? WHERE session_id = 'open'`, [NOW + 40_000]);
    expect((await h.title('open')).outcome).toBe('already');
    expect(h.launches).toHaveLength(2);
  });

  it('refuses a second ask while the first run may still be writing, and admits one after the window', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect((await h.ask('s1')).outcome).toBe('dispatched');
    expect((await h.ask('s1', NOW + 1000)).outcome).toBe('already');
    expect((await h.ask('s1', NOW + OWNER_TITLING_WINDOW_MS - 1)).outcome).toBe('already');
    expect((await h.ask('s1', NOW + OWNER_TITLING_WINDOW_MS + 1)).outcome).toBe('dispatched');
    expect(h.launches).toHaveLength(2);
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
