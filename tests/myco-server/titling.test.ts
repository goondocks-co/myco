/**
 * The titler: one bounded provider call per ended session, claimed before it is
 * made, inside a per-Project hourly ceiling, with the credential travelling only
 * to its provider's own endpoint and never into telemetry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import {
  ANSWER_MAX_TOKENS, ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_MODEL, parseTitleAnswer, resolveTitlingProvider, sessionMaterial, titleSession, titlingPrompt,
} from '@myco-server-worker/core/titling.js';
import { MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, MAX_TITLES_PER_PROJECT_PER_HOUR, MATERIAL_EXCERPT_CHARS } from '@myco-server-worker/constants.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = 'sk-ant-TEST-SECRET-VALUE-9f3b';
const ANSWER = { title: 'Wave-based executor and per-task provider config.', summary: 'Built the executor. Touched runner.ts and tasks.yaml. Tests pass.' };

interface Sent { url: string; init: RequestInit }

function harness(answers: Array<Response | Error> = []) {
  const e = sqliteEnv();
  const sent: Sent[] = [];
  const outbound: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? Response.json({ content: [{ type: 'text', text: JSON.stringify(ANSWER) }] });
  }) as unknown as typeof fetch;
  const env: ServerEnv = { ...serverEnvFromBindings({ ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } as never), outbound };
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
  const row = (id: string) => e.sqlite.query(`SELECT title, summary, titled_at FROM sessions WHERE session_id = ?`).get(id) as { title: string | null; summary: string | null; titled_at: number | null };
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  return { ...e, env, sent, setting, session, prompt, response, row, secrets, title: (id: string) => titleSession(env, { projectId: 'proj_1', sessionId: id, now: NOW }) };
}

const logged: string[] = [];
const originalLog = console.log;
beforeEach(() => { logged.length = 0; console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
afterEach(() => { console.log = originalLog; });

const seedAnthropic = async (h: ReturnType<typeof harness>) => {
  h.setting('agent.provider.type', 'anthropic');
  await h.secrets.put('anthropic', KEY, 'mem_1', NOW);
};

describe('titleSession', () => {
  it('claims the session, calls the provider once with bounded material, writes title and summary, and skips every later attempt without a request', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'Fix the flaky test in runner.ts\nplease', NOW - 9000);
    h.response('s1', 'p1', 'r1', 'Looking at runner.ts now.', NOW - 8500);
    h.prompt('s1', 'p2', 'Now add the retry', NOW - 8000);
    h.prompt('s1', 'p0', 'system preamble', NOW - 9500, 'system');

    expect(await h.title('s1')).toBe('titled');
    expect(h.row('s1')).toEqual({ title: 'Wave-based executor and per-task provider config', summary: ANSWER.summary, titled_at: NOW });
    expect(h.sent).toHaveLength(1);
    const [call] = h.sent;
    expect(call.url).toBe(ANTHROPIC_MESSAGES_URL);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    const body = JSON.parse(call.init.body as string) as { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.max_tokens).toBe(ANSWER_MAX_TOKENS);
    expect(body.messages[0].content).toContain('Prompt 1: Fix the flaky test in runner.ts\nplease\nResponse: Looking at runner.ts now.');
    expect(body.messages[0].content).toContain('Prompt 2: Now add the retry');
    expect(body.messages[0].content).not.toContain('system preamble');
    expect(body.messages[0].content).toContain('agent claude-code; branch main');
    expect(logged.some((l) => l.includes('session_titled'))).toBe(true);

    expect(await h.title('s1')).toBe('already');
    expect(h.sent).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(ANSWER.summary);
  });

  it('makes one attempt per session even when two ends race, and none for a session that has not ended', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.session('open', { endedAt: null });
    h.prompt('open', 'p2', 'hello', NOW - 9000);
    const [a, b] = await Promise.all([h.title('s1'), h.title('s1')]);
    expect([a, b].sort()).toEqual(['already', 'titled']);
    expect(h.sent).toHaveLength(1);
    expect(await h.title('open')).toBe('already');
    expect(h.sent).toHaveLength(1);
  });

  it('stays inside the per-Project hourly ceiling', async () => {
    const h = harness();
    await seedAnthropic(h);
    for (let i = 0; i < MAX_TITLES_PER_PROJECT_PER_HOUR; i += 1) {
      h.session(`old${i}`);
      h.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id = ?`, [NOW - 60_000, `old${i}`]);
    }
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    expect(await h.title('s1')).toBe('budget');
    expect(h.sent).toHaveLength(0);
    expect(h.row('s1').titled_at).toBe(NOW);
    h.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id IN ('old0', 'old1')`, [NOW - 2 * 60 * 60 * 1000]);
    h.session('s2');
    h.prompt('s2', 'p2', 'hello', NOW - 9000);
    expect(await h.title('s2')).toBe('titled');
  });

  it('calls nothing for an empty session, without a provider, without the provider\'s credential, or for a local provider with no endpoint named', async () => {
    const h = harness();
    h.session('empty');
    expect(await h.title('empty')).toBe('no_material');

    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.prompt('s1', 'spilled', null, NOW - 9500);
    expect(await h.title('s1')).toBe('no_provider');

    h.setting('agent.provider.type', 'anthropic');
    h.session('s2');
    h.prompt('s2', 'p2', 'hello', NOW - 9000);
    expect(await h.title('s2')).toBe('no_credential');

    h.setting('agent.provider.type', 'ollama');
    h.setting('agent.provider.model', 'llama3');
    h.session('s3');
    h.prompt('s3', 'p3', 'hello', NOW - 9000);
    expect(await h.title('s3')).toBe('local_provider');

    h.setting('agent.provider.type', 'openai-compatible');
    h.session('s4');
    h.prompt('s4', 'p4', 'hello', NOW - 9000);
    expect(await h.title('s4')).toBe('no_endpoint');

    h.setting('agent.provider.type', 'openai');
    h.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'agent.provider.model'`);
    h.session('s5');
    h.prompt('s5', 'p5', 'hello', NOW - 9000);
    expect(await h.title('s5')).toBe('no_model');

    expect(h.sent).toHaveLength(0);
  });

  it('sends the openai and openrouter credentials only to their own endpoints, and no credential to an endpoint the operator names', async () => {
    const answer = () => Response.json({ choices: [{ message: { content: `here you go ${JSON.stringify(ANSWER)}` } }] });
    const h = harness([answer(), answer(), answer()]);
    await h.secrets.put('openai', 'sk-openai-TEST', 'mem_1', NOW);
    await h.secrets.put('openrouter', 'sk-or-TEST', 'mem_1', NOW);
    h.setting('agent.provider.model', 'gpt-x');
    h.setting('agent.provider.base_url', 'https://evil.example/v1/');
    for (const id of ['s1', 's2', 's3']) { h.session(id); h.prompt(id, `p_${id}`, 'hello', NOW - 9000); }

    h.setting('agent.provider.type', 'openai');
    expect(await h.title('s1')).toBe('titled');
    h.setting('agent.provider.type', 'openrouter');
    expect(await h.title('s2')).toBe('titled');
    h.setting('agent.provider.type', 'openai-compatible');
    expect(await h.title('s3')).toBe('titled');

    expect(h.sent.map((s) => [s.url, (s.init.headers as Record<string, string>).authorization ?? null])).toEqual([
      ['https://api.openai.com/v1/chat/completions', 'Bearer sk-openai-TEST'],
      ['https://openrouter.ai/api/v1/chat/completions', 'Bearer sk-or-TEST'],
      ['https://evil.example/v1/chat/completions', null],
    ]);
    expect(h.row('s3').title).toBe('Wave-based executor and per-task provider config');
    expect(logged.join('\n')).not.toContain('sk-openai-TEST');
    expect(logged.join('\n')).not.toContain('sk-or-TEST');
  });

  it('takes the task override for provider and model ahead of the defaults', async () => {
    const h = harness();
    await seedAnthropic(h);
    h.setting('agent.provider.model', 'claude-default');
    h.setting('agent.tasks', { 'title-summary': { provider: 'anthropic', model: 'claude-for-titles' } });
    const resolved = await resolveTitlingProvider(h.env.db, h.secrets);
    expect(resolved).toEqual({ ok: true, provider: { kind: 'anthropic', model: 'claude-for-titles', key: KEY } });
  });

  it('writes nothing on a malformed answer, a provider refusal, or an unreachable provider, and resolves rather than rejecting', async () => {
    const h = harness([
      Response.json({ content: [{ type: 'text', text: 'no json here' }] }),
      new Response('nope', { status: 429 }),
      new Error('socket hung up'),
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    await seedAnthropic(h);
    for (const id of ['s1', 's2', 's3', 's4']) { h.session(id); h.prompt(id, `p_${id}`, 'hello', NOW - 9000); }
    expect(await h.title('s1')).toBe('malformed');
    expect(await h.title('s2')).toBe('provider');
    expect(await h.title('s3')).toBe('unreachable');
    expect(await h.title('s4')).toBe('malformed');
    for (const id of ['s1', 's2', 's3', 's4']) expect(h.row(id)).toEqual({ title: null, summary: null, titled_at: NOW });
    const broken = { ...h.env, db: { prepare: () => { throw new Error('store detached'); } } as never };
    expect(await titleSession(broken, { projectId: 'proj_1', sessionId: 's1', now: NOW })).toBe('unreachable');
    expect(logged.filter((l) => l.includes('session_title_failed'))).toHaveLength(5);
    expect(logged.some((l) => l.includes('"status":429'))).toBe(true);
    expect(logged.join('\n')).not.toContain('nope');
    expect(logged.join('\n')).not.toContain('<html>');
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
    const material = await sessionMaterial(h.env.db, 'proj_1', 's1');
    expect(material.length).toBeLessThanOrEqual(MAX_MATERIAL_PROMPTS);
    expect(material.length).toBeGreaterThan(2);
    expect(material[0].prompt.length).toBe(MATERIAL_EXCERPT_CHARS);
    expect(material[0].response).toBe('first response');
    expect(material[1].response).toBeNull();
    expect(material[2].response?.length).toBe(MATERIAL_EXCERPT_CHARS);
    expect(material.reduce((n, m) => n + m.prompt.length + (m.response?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    expect(titlingPrompt({ agent: null, branch: null }, material)).toContain('agent unknown; branch unknown');
  });

  it('accepts only an answer carrying a bounded title and summary', () => {
    expect(parseTitleAnswer('Sure: {"title": "  Did the thing.  ", "summary": " It worked. "} thanks')).toEqual({ title: 'Did the thing', summary: 'It worked.' });
    expect(parseTitleAnswer('{"title": "", "summary": "x"}')).toBeNull();
    expect(parseTitleAnswer(`{"title": "${'t'.repeat(81)}", "summary": "x"}`)).toBeNull();
    expect(parseTitleAnswer(`{"title": "ok", "summary": "${'s'.repeat(1201)}"}`)).toBeNull();
    expect(parseTitleAnswer('{"title": 5, "summary": "x"}')).toBeNull();
    expect(parseTitleAnswer('nothing')).toBeNull();
  });
});
