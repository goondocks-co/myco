/**
 * The run-only tool surface: what a run calls that a member and a grant cannot.
 *
 * Two things are held here that no other suite can. That the two surfaces do
 * not overlap — a member or a grant naming a run-only tool is told it does not
 * exist — and that the read discipline the deleted `/runs/*` routes carried
 * (previews, a full-read budget, body truncation, digest windows, full-fidelity
 * material) still binds now that those reads are MCP calls.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';
import { RUN_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { SPORE_PREVIEW_CHARS } from '@myco-server-worker/core/spores.js';
import { RUN_TOOL_MAP, RUN_TOOL_REGISTRY, runAllowlist, runDefinitions } from '@myco-server-worker/mcp/run-surface.js';
import { GRANT_INSTRUCTIONS, RUN_INSTRUCTIONS, SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_MAX_BYTES } from '@myco-server-worker/mcp/server.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const NOW = Date.now();
const SWEEP = 'supersession-sweep';
const DIGEST = 'digest-only';
const TITLING = 'title-summary';
const SMOKE = 'container-smoke';

const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
const post = (token: string, body: string, extra: Record<string, string> = {}) =>
  new Request('https://s/mcp', { method: 'POST', headers: { ...memberHeaders(token), ...extra }, body });
/** A grant presents its key and a source identity; it carries no member headers. */
const grantRequest = (key: string, body: string) =>
  new Request('https://s/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '1.2.3.4' }, body });

async function setup() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at)
                VALUES ('proj_1', 'sess_1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
  const harness = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);
  const member = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);

  const dispatch = async (runId: string, task: string, over: { sessionId?: string | null; dryRun?: boolean; mode?: string } = {}) => {
    const runContext = JSON.stringify({
      ...(over.sessionId === null ? {} : { session_id: over.sessionId ?? 'sess_1' }),
      ...(over.mode === undefined ? {} : { mode: over.mode }),
      timeoutSeconds: 300,
    });
    expect(await recordDispatch(e.db, { projectId: 'proj_1' }, {
      id: runId, agentId: 'myco-agent', task, provider: 'anthropic', model: null,
      runContext, dispatchedBy: harness.tokenId, startedAt: NOW, dryRun: over.dryRun,
    })).toBe(true);
    e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE project_id = 'proj_1' AND id = ?`, [runId]);
  };

  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await worker.fetch(post(token, rpc('tools/call', { name, arguments: args })), e.env);
    const body = await res.json() as any;
    return { status: res.status, result: body.result?.structuredContent?.result, error: body.error };
  };
  const list = async (token: string) => {
    const res = await worker.fetch(post(token, rpc('tools/list')), e.env);
    return ((await res.json() as any).result.tools as Array<{ name: string }>).map((t) => t.name);
  };
  const initialize = async (token: string) => {
    const res = await worker.fetch(post(token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })), e.env);
    return (await res.json() as any).result.instructions as string;
  };
  const spore = (id: string, content: string) =>
    e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, importance, tags, created_at, updated_at)
                  VALUES ('proj_1', ?, 'myco-agent', 'gotcha', 'active', ?, 5, '[]', ?, ?)`, [id, content, NOW, NOW]);
  const prompt = (id: string, over: { origin?: string; session?: string; createdAt?: number } = {}) =>
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, ?, ?, ?, ?, ?, 'tok_1', ?)`,
      [over.session ?? 'sess_1', id, `e_${id}`, `body of ${id}`, over.origin ?? 'user', `h_${id}`, over.createdAt ?? NOW, over.createdAt ?? NOW, NOW]);

  return { ...e, harness, member, dispatch, call, list, initialize, spore, prompt };
}

describe('the run surface and the member surface do not overlap', () => {
  it('shares no tool name, and lists no run-only tool to a member or a grant', async () => {
    const { env, db, harness, member, dispatch, list } = await setup();
    await dispatch('run_1', SWEEP);
    const grant = await issueExternalGrant(db, { projectId: 'proj_1' }, 'copilot', 'owner', NOW);

    const forRun = await list(harness.token);
    expect(forRun.filter((n) => RUN_TOOLS.includes(n as never)).sort()).toEqual(['myco_run', 'myco_run_spores']);
    expect((await list(member.token)).filter((n) => RUN_TOOLS.includes(n as never))).toEqual([]);

    const res = await worker.fetch(grantRequest(grant.key, rpc('tools/list')), env);
    const listed = ((await res.json() as any).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(listed.filter((n) => RUN_TOOLS.includes(n as never))).toEqual([]);
  });

  it('tells a member and a grant that every run-only (tool, op) does not exist, and writes nothing', async () => {
    const { executed, db, member, call } = await setup();
    await issueExternalGrant(db, { projectId: 'proj_1' }, 'copilot', 'owner', NOW);
    const before = executed.length;
    for (const [tool, entry] of Object.entries(RUN_TOOL_REGISTRY)) {
      for (const op of Object.keys(entry.ops)) {
        const answered = await call(member.token, tool, { op, key: 'k', value: 'v', prompt_id: 'p_1', title: 't', summary: 's', id: 'x', action: 'a' });
        expect({ tool, op, code: answered.error?.data?.code }).toEqual({ tool, op, code: 'unknown_tool' });
      }
    }
    expect(executed.slice(before).filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))).toEqual([]);
  });

  it('routes no surviving /runs/* path to an operation the run surface serves, and every remaining path is classified', () => {
    /**
     * Why each `/runs/*` route still exists. `null` means no run tool performs
     * it. `/runs/report` is the one path a run tool DOES perform, kept until
     * #1170: the push-launch seam's container reaches it over HTTP and speaks
     * no MCP. Removing the exemption is what forces the route's deletion.
     */
    const RUN_ROUTE_REASONS: Record<string, { tool: string; op: string; until: string } | null> = {
      '/runs/claim': null, '/runs/get': null, '/runs/update': null, '/runs/failed': null,
      '/runs/resume-admission': null, '/runs/supersede': null, '/runs/reports': null,
      '/runs/events': null, '/runs/instruction': null, '/runs/embedding-step': null,
      '/runs/digest': null, '/runs/digest-write': null, '/runs/repository': null, '/runs/canopy-map': null,
      '/runs/report': { tool: 'myco_run', op: 'report', until: '#1170' },
    };
    const present = ROUTES.filter((r) => r.path.startsWith('/runs/')).map((r) => r.path).sort();
    // Every surviving path is classified: a route added later fails here until
    // someone answers whether a run tool performs it.
    expect(present).toEqual(Object.keys(RUN_ROUTE_REASONS).sort());
    // And every path a run tool performs is gone, unless it carries the seam's
    // exemption. This is the issue's disjointness gate.
    for (const [path, reason] of Object.entries(RUN_ROUTE_REASONS)) {
      if (reason === null) continue;
      expect({ path, keyed: reason.op in RUN_TOOL_REGISTRY[reason.tool].ops }).toEqual({ path, keyed: true });
      expect({ path, until: reason.until }).toEqual({ path, until: '#1170' });
    }
  });
});

describe('the handshake is the principal\'s', () => {
  it('answers each principal its own instructions, under the ceiling, naming no tool that principal cannot call', async () => {
    const { db, harness, member, dispatch, initialize, env } = await setup();
    await dispatch('run_1', SWEEP);
    const grant = await issueExternalGrant(db, { projectId: 'proj_1' }, 'copilot', 'owner', NOW);

    expect(await initialize(member.token)).toBe(SERVER_INSTRUCTIONS);
    expect(await initialize(harness.token)).toBe(RUN_INSTRUCTIONS);
    const res = await worker.fetch(grantRequest(grant.key, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })), env);
    expect((await res.json() as any).result.instructions).toBe(GRANT_INSTRUCTIONS);

    for (const [what, text] of [['member', SERVER_INSTRUCTIONS], ['run', RUN_INSTRUCTIONS], ['grant', GRANT_INSTRUCTIONS]] as const) {
      expect({ what, within: Buffer.byteLength(text, 'utf8') <= SERVER_INSTRUCTIONS_MAX_BYTES }).toEqual({ what, within: true });
    }
    // The rule an unbound principal alone is subject to: a write without a
    // Project is refused only where the credential is not already bound to one.
    const REFUSAL = 'A write without it is refused.';
    expect(SERVER_INSTRUCTIONS).toContain(REFUSAL);
    expect(RUN_INSTRUCTIONS).not.toContain(REFUSAL);
    expect(GRANT_INSTRUCTIONS).not.toContain(REFUSAL);
    // And neither bound principal is pointed at a tool it cannot reach.
    for (const [what, text] of [['run', RUN_INSTRUCTIONS], ['grant', GRANT_INSTRUCTIONS]] as const) {
      expect({ what, plans: text.includes('myco_plans') }).toEqual({ what, plans: false });
    }
    expect(RUN_INSTRUCTIONS).not.toContain('myco_cortex');
  });
});

describe('a run reports whatever its task declares', () => {
  it('serves report to a task with no declared tools at all, so a run that owes a close report can file one', async () => {
    const { harness, dispatch, call, sqlite } = await setup();
    expect(TASK_TOOLS[SMOKE]).toEqual([]);
    await dispatch('run_smoke', SMOKE);
    const answered = await call(harness.token, 'myco_run', { op: 'report', action: 'container-smoke', summary: 'the harness answered' });
    expect(answered.result).toEqual({ recorded: true, action: 'container-smoke' });
    expect(sqlite.query(`SELECT agent_id AS a, action FROM agent_reports WHERE run_id = 'run_smoke'`).all())
      .toEqual([{ a: 'myco-agent', action: 'container-smoke' }]);
  });

  it('takes the report\'s agent off the run, never off the arguments', async () => {
    const { harness, dispatch, call } = await setup();
    await dispatch('run_1', SWEEP);
    const answered = await call(harness.token, 'myco_run', { op: 'report', action: 'x', summary: 's', agentId: 'someone-else' });
    expect(answered.error.data.code).toBe('invalid_input');
  });

  it('keeps report on a dry run, which writes nothing else', async () => {
    const { harness, dispatch, call, list } = await setup();
    await dispatch('run_dry', SWEEP, { dryRun: true });
    expect(await list(harness.token)).toContain('myco_run');
    expect((await call(harness.token, 'myco_run', { op: 'report', action: 'skip', summary: 'nothing to do' })).result)
      .toEqual({ recorded: true, action: 'skip' });
    expect((await call(harness.token, 'myco_spores', { op: 'save', content: 'x', type: 'gotcha' })).error.data.code).toBe('unknown_tool');
  });
});

describe('the read window binds on the MCP path', () => {
  it('serves previews rather than bodies, cut to the window', async () => {
    const { harness, dispatch, call, spore } = await setup();
    await dispatch('run_1', SWEEP);
    spore('sp_long', 'x'.repeat(SPORE_PREVIEW_CHARS * 3));
    const answered = await call(harness.token, 'myco_run_spores', { op: 'list' }) as any;
    expect(answered.result.total).toBe(1);
    expect(answered.result.spores[0].preview.length).toBe(SPORE_PREVIEW_CHARS);
    expect(Object.keys(answered.result.spores[0]).sort()).toEqual(['created_at', 'id', 'importance', 'observation_type', 'preview']);
  });

  it('spends a full read per get, refuses past the budget, and spends one even for an id the Project does not hold', async () => {
    const { harness, dispatch, call, spore } = await setup();
    await dispatch('run_1', SWEEP);
    const budget = readWindowFor(SWEEP).sporeFullReads;
    for (let i = 0; i < budget; i += 1) spore(`sp_${i}`, 'body');
    // A read of an id the Project does not hold still spends a unit: the count
    // is taken before the row is fetched.
    expect((await call(harness.token, 'myco_run_spores', { op: 'get', id: 'sp_absent' }) as any).result).toEqual({ ok: false, error: 'Spore not found' });
    for (let i = 1; i < budget; i += 1) {
      expect((await call(harness.token, 'myco_run_spores', { op: 'get', id: `sp_${i}` }) as any).result.spore.id).toBe(`sp_${i}`);
    }
    expect((await call(harness.token, 'myco_run_spores', { op: 'get', id: 'sp_0' }) as any).result).toEqual({ spore: null, budget: 'spent' });
  });

  it('cuts a body past the window and says so, and gives a digest run the tier window rather than a sweep\'s', async () => {
    const sweep = readWindowFor(SWEEP);
    const digest = readWindowFor(DIGEST);
    expect(digest.sporeBodyChars).toBeLessThan(sweep.sporeBodyChars);
    expect(digest.sporePage).toBeLessThan(sweep.sporePage);
    expect(digest.sessionPage).toBeLessThan(sweep.sessionPage);

    const { harness, dispatch, call, spore } = await setup();
    await dispatch('run_d', DIGEST);
    spore('sp_big', 'y'.repeat(sweep.sporeBodyChars + 10));
    const answered = await call(harness.token, 'myco_run_spores', { op: 'get', id: 'sp_big' }) as any;
    expect(answered.result.truncated).toBe(true);
    expect(answered.result.spore.content.length).toBe(digest.sporeBodyChars);
  });

  it('reads material at full fidelity, so a degraded transcript is not material a run reasons over', async () => {
    const { harness, member, dispatch, call, sqlite } = await setup();
    await dispatch('run_d', DIGEST);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at, ended_at)
                VALUES ('proj_1', 'sess_degraded', 'm1', 'tok_1', ?, ?, ?, ?)`, [NOW - 5_000, NOW, NOW - 5_000, NOW]);
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, first_received_at, last_received_at, token_id, fidelity)
                VALUES ('proj_1', 't_1', 'sess_degraded', 'm1', ?, ?, 'tok_1', 'partial')`, [NOW, NOW]);

    const forRun = (await call(harness.token, 'myco_run_sessions', { op: 'list' }) as any).result.sessions.map((s: any) => s.id);
    expect(forRun).not.toContain('sess_degraded');
    const forMember = await call(member.token, 'myco_sessions', { op: 'list' }) as any;
    expect((forMember.result as Array<{ id: string }>).map((s) => s.id)).toContain('sess_degraded');
  });
});

describe('the session page a run reads', () => {
  it('serves settled sessions only, within a clamped page, cutting every part of a row to its own bound', async () => {
    const { harness, dispatch, call, sqlite } = await setup();
    await dispatch('run_d', DIGEST);
    const window = readWindowFor(DIGEST);
    for (let i = 0; i < 4; i += 1) {
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title, summary)
                  VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?, ?)`,
        [`s${i}`, NOW - 1_000 + i, NOW, NOW - 1_000 + i, NOW, 'title '.repeat(200), 'summary '.repeat(200)]);
    }
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at)
                VALUES ('proj_1', 'live', 'm1', 'tok_1', ?, ?, ?)`, [NOW, NOW, NOW]);

    const served = (await call(harness.token, 'myco_run_sessions', { op: 'list', limit: 9999 }) as any).result.sessions;
    expect(served.map((r: any) => r.id)).not.toContain('live');
    expect(served.length).toBeLessThanOrEqual(window.sessionPage);
    const row = served.find((r: any) => r.id === 's0');
    expect(row.title.length).toBeLessThanOrEqual(window.sessionTitleChars + 1);
    expect(row.label.length).toBeLessThanOrEqual(window.sessionLabelChars + 1);
    expect(row.summary.length).toBeLessThanOrEqual(window.sessionSummaryChars + 1);
  });

  it('hands a digest run its tier window rather than the page a sweep may ask for', async () => {
    const sweep = readWindowFor(SWEEP);
    const digest = readWindowFor(DIGEST);

    const d = await setup();
    await d.dispatch('run_d', DIGEST);
    for (let i = 0; i < digest.sporePage + 1; i += 1) d.spore(`sp_${i}`, `spore ${i}`);
    expect(((await d.call(d.harness.token, 'myco_run_spores', { op: 'list', limit: 200 }) as any).result.spores).length).toBe(digest.sporePage);

    const w = await setup();
    await w.dispatch('run_s', SWEEP);
    for (let i = 0; i < digest.sporePage + 1; i += 1) w.spore(`sp_${i}`, `spore ${i}`);
    expect(((await w.call(w.harness.token, 'myco_run_spores', { op: 'list', limit: 200 }) as any).result.spores).length).toBe(digest.sporePage + 1);
    expect(sweep.sporePage).toBeGreaterThan(digest.sporePage);
  });
});

describe('a run\'s state is a compare-and-set', () => {
  it('carries a read-modify-write, refuses the write whose version is stale, and lets the loser retry from a fresh read', async () => {
    const { harness, dispatch, call } = await setup();
    await dispatch('run_e', 'extract-only');

    expect((await call(harness.token, 'myco_run', { op: 'state_get', key: 'k' }) as any).result)
      .toEqual({ key: 'k', value: null, updated_at: null });

    // Both callers read the same absent value; only one write may land.
    const a = await call(harness.token, 'myco_run', { op: 'state_set', key: 'k', value: 'from-a' }) as any;
    const b = await call(harness.token, 'myco_run', { op: 'state_set', key: 'k', value: 'from-b' }) as any;
    expect([a.result.applied, b.result.applied]).toEqual([true, false]);

    const read = (await call(harness.token, 'myco_run', { op: 'state_get', key: 'k' }) as any).result;
    expect(read.value).toBe('from-a');
    expect(typeof read.version).toBe('string');

    const stale = await call(harness.token, 'myco_run', { op: 'state_set', key: 'k', value: 'from-b' }) as any;
    expect(stale.result.applied).toBe(false);
    const retry = await call(harness.token, 'myco_run', { op: 'state_set', key: 'k', value: 'from-b', version: read.version }) as any;
    expect(retry.result.applied).toBe(true);
    expect((await call(harness.token, 'myco_run', { op: 'state_get', key: 'k' }) as any).result.value).toBe('from-b');
  });

  it('keeps state under the run\'s own agent, and loses state_set on a dry run', async () => {
    const { harness, dispatch, call, sqlite, list } = await setup();
    await dispatch('run_e', 'extract-only');
    await call(harness.token, 'myco_run', { op: 'state_set', key: 'shared', value: 'one' });
    expect(sqlite.query(`SELECT agent_id AS a, value AS v FROM agent_state WHERE project_id = 'proj_1' AND key = 'shared'`).all())
      .toEqual([{ a: 'myco-agent', v: 'one' }]);

    const dry = await setup();
    await dry.dispatch('run_dry', 'extract-only', { dryRun: true });
    const ops = (await dry.list(dry.harness.token)).includes('myco_run');
    expect(ops).toBe(true);
    expect((await dry.call(dry.harness.token, 'myco_run', { op: 'state_set', key: 'k', value: 'v' })).error.data.code).toBe('unknown_tool');
    expect((await dry.call(dry.harness.token, 'myco_run', { op: 'state_get', key: 'k' })).error).toBeUndefined();
  });
});

describe('the extraction cursor', () => {
  it('pages forward without repeating, drops a marked prompt, and reads no body unless asked', async () => {
    const { harness, dispatch, call, prompt } = await setup();
    await dispatch('run_e', 'extract-only');
    for (let i = 0; i < 3; i += 1) prompt(`p_${i}`, { createdAt: NOW - 3_000 + i });

    const first = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed', limit: 2 }) as any).result;
    expect(first.prompts.map((p: any) => p.prompt_id)).toEqual(['p_0', 'p_1']);
    expect(first.prompts[0].text).toBeUndefined();
    const second = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed', limit: 2, cursor: first.next_cursor }) as any).result;
    expect(second.prompts.map((p: any) => p.prompt_id)).toEqual(['p_2']);

    expect((await call(harness.token, 'myco_run_prompts', { op: 'mark_processed', prompt_id: 'p_0' }) as any).result)
      .toEqual({ prompt_id: 'p_0', marked: true });
    const after = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed' }) as any).result;
    expect(after.prompts.map((p: any) => p.prompt_id)).toEqual(['p_1', 'p_2']);

    const withText = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed', include_text: true }) as any).result;
    expect(withText.prompts[0].text).toBe('body of p_1');
    expect((await call(harness.token, 'myco_run_prompts', { op: 'mark_processed', prompt_id: 'p_absent' }) as any).result.marked).toBe(false);
  });

  it('reads the origins a person speaks through and skips the rest, and hides an in-flight session unless asked', async () => {
    const { harness, dispatch, call, prompt, sqlite } = await setup();
    await dispatch('run_e', 'extract-only');
    prompt('p_user', { origin: 'user', createdAt: NOW - 3_000 });
    prompt('p_unknown', { origin: 'unknown', createdAt: NOW - 2_900 });
    prompt('p_system', { origin: 'system', createdAt: NOW - 2_800 });
    prompt('p_dispatch', { origin: 'agent_dispatch', createdAt: NOW - 2_700 });
    prompt('p_hook', { origin: 'hook_injected', createdAt: NOW - 2_600 });
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at)
                VALUES ('proj_1', 'sess_open', 'm1', 'tok_1', ?, ?, ?)`, [NOW, NOW, NOW]);
    prompt('p_open', { session: 'sess_open', createdAt: NOW - 2_500 });

    const settled = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed' }) as any).result;
    expect(settled.prompts.map((p: any) => p.prompt_id)).toEqual(['p_user', 'p_unknown']);
    const withOpen = (await call(harness.token, 'myco_run_prompts', { op: 'unprocessed', include_active: true }) as any).result;
    expect(withOpen.prompts.map((p: any) => p.prompt_id)).toEqual(['p_user', 'p_unknown', 'p_open']);
  });
});

describe('a titling run reads and writes its own session', () => {
  it('answers material for the dispatch-named session with no argument, and writes the title through the dispatch\'s mode', async () => {
    const { harness, dispatch, call, sqlite } = await setup();
    await dispatch('run_t', TITLING, { mode: 'claim' });
    const material = (await call(harness.token, 'myco_run_sessions', { op: 'material' }) as any).result;
    expect(material.session_id).toBe('sess_1');
    expect(material.status).toBe('completed');

    expect((await call(harness.token, 'myco_run_sessions', { op: 'title', title: 'A title', summary: 'A summary' }) as any).result)
      .toEqual({ session_id: 'sess_1', written: true });
    expect(sqlite.query(`SELECT title FROM sessions WHERE session_id = 'sess_1'`).get()).toEqual({ title: 'A title' });

    // At a session's end a title is written only where none exists; the mode is
    // the dispatch's, never the caller's.
    const second = await setup();
    await second.dispatch('run_t2', TITLING, { mode: 'claim' });
    second.sqlite.run(`UPDATE sessions SET title = 'Already', summary = 'Set' WHERE session_id = 'sess_1'`);
    expect((await second.call(second.harness.token, 'myco_run_sessions', { op: 'title', title: 'B', summary: 'C' }) as any).result.written).toBe(false);
  });

  it('refuses a run whose dispatch named no session, rather than failing its write', async () => {
    const { harness, dispatch, call } = await setup();
    await dispatch('run_t', TITLING, { sessionId: null, mode: 'claim' });
    expect((await call(harness.token, 'myco_run_sessions', { op: 'material' }) as any).result).toEqual({ ok: false, error: 'this run names no session' });
  });
});

describe('the run map', () => {
  it('gives every task in the catalogue a surface its declared tools reach, and nothing else', () => {
    for (const [task, tools] of Object.entries(TASK_TOOLS)) {
      const allow = runAllowlist(tools, { dryRun: false });
      const listed = runDefinitions(allow).map((d) => d.name).sort();
      const expected = [...new Set(['myco_run', ...tools.flatMap((t) => (RUN_TOOL_MAP[t] ?? []).map((x) => x.tool))])].sort();
      expect({ task, listed }).toEqual({ task, listed: expected });
    }
  });
});
