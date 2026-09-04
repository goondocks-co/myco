/**
 * Prompt recall: the capability gate over everything, the two contributors and
 * the order they stand in, the once-per-session record, the bound at a part
 * boundary, and the route that serves them.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import {
  composePromptContext, detectsPlanIntent, partsWithinBound, PLAN_INTENT_NUDGE, PROMPT_CONTEXT_MAX_CHARS,
  recallLeaves, recordSessionInjection, type RecallLeaves,
} from '@myco-server-worker/core/recall.js';
import { insertSpore, type SporeInsert } from '@myco-server-worker/core/spores.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const SESSION = 'sess_1';
/** Plain enough to carry no planning intent, long enough to clear the selector's floor. */
const PROMPT = 'what did we settle on for the selector';
const PLANNING_PROMPT = 'let us write the implementation plan for the selector';

const ON: RecallLeaves = { injection: { enabled: true, maxPerPrompt: 3 }, planNudge: true };

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

const spore = (id: string, over: Partial<SporeInsert> = {}): SporeInsert => ({
  id, agentId: AGENT, sessionId: null, promptId: null, observationType: 'gotcha',
  content: `content of ${id}`, context: null, filePath: null, tags: null,
  contentHash: null, properties: null, createdAt: NOW, ...over,
});

const compose = (
  db: RelationalStore,
  over: Partial<{ leaves: RecallLeaves; capabilityOn: boolean; scope: ReadScope; sessionId: string; promptId: string; text: string; now: number }> = {},
) => composePromptContext(db, over.scope ?? SCOPE, over.leaves ?? ON, over.capabilityOn ?? true, {
  sessionId: over.sessionId ?? SESSION,
  promptId: over.promptId ?? 'p1',
  text: over.text ?? PROMPT,
  now: over.now ?? NOW,
});

const sessionRows = (sqlite: Database) =>
  sqlite.query(`SELECT project_id, session_id, kind, created_at FROM session_injections`).all() as Record<string, string | number>[];

describe('the recall leaves', () => {
  it('defaults the nudge on and carries the injection leaves through', () => {
    expect(recallLeaves({})).toEqual({ injection: { enabled: true, maxPerPrompt: 3 }, planNudge: true });
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': false }).planNudge).toBe(false);
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': 'yes' }).planNudge).toBe(true);
    expect(recallLeaves({ 'cortex.spores.max_per_prompt': 1 }).injection.maxPerPrompt).toBe(1);
  });
});

describe('planning intent', () => {
  it('answers on the fixed keyword set, word-bounded and case-insensitive', () => {
    for (const text of ['write the PLAN', 'a design doc', 'the roadmap for Q3', 'phase two', 'implementation plan']) {
      expect({ text, intent: detectsPlanIntent(text) }).toEqual({ text, intent: true });
    }
    for (const text of ['planetary orbits', 'the specification of a specimen', 'ship it']) {
      expect({ text, intent: detectsPlanIntent(text) }).toEqual({ text, intent: false });
    }
  });
});

describe('the capability gate', () => {
  it('is total: no spores, no nudge, no record, and the gate names itself', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    const shut = await compose(db, { capabilityOn: false, text: PLANNING_PROMPT });
    expect(shut).toEqual({ context: '', parts: [], skipped: ['capability'] });
    expect(sessionRows(sqlite)).toEqual([]);
    expect(sqlite.query(`SELECT COUNT(*) c FROM spore_injections`).get()).toEqual({ c: 0 });
  });
});

describe('the plan nudge', () => {
  it('fires on intent once per session, whatever the spore switch says', async () => {
    const { db, sqlite } = store();
    const sporesOff: RecallLeaves = { injection: { enabled: false, maxPerPrompt: 3 }, planNudge: true };

    const first = await compose(db, { leaves: sporesOff, text: PLANNING_PROMPT, promptId: 'p1' });
    expect(first.context).toBe(PLAN_INTENT_NUDGE);
    expect(first.parts).toEqual([{ kind: 'plan-nudge' }]);
    expect(first.skipped).toEqual([]);

    const again = await compose(db, { leaves: sporesOff, text: `${PLANNING_PROMPT} again`, promptId: 'p2' });
    expect(again).toEqual({ context: '', parts: [], skipped: [] });

    expect(sessionRows(sqlite)).toEqual([{ project_id: SCOPE.projectId, session_id: SESSION, kind: 'plan-nudge', created_at: NOW }]);
  });

  it('stays silent for a prompt with no planning intent, and for a Deployment that switched it off', async () => {
    const { db, sqlite } = store();
    expect((await compose(db, { text: PROMPT })).parts).toEqual([]);
    const nudgeOff: RecallLeaves = { injection: { enabled: false, maxPerPrompt: 3 }, planNudge: false };
    expect((await compose(db, { leaves: nudgeOff, text: PLANNING_PROMPT })).parts).toEqual([]);
    expect(sessionRows(sqlite)).toEqual([]);
  });

  it('keeps the record to its own session and its own Project', async () => {
    const { db, sqlite } = store();
    await compose(db, { text: PLANNING_PROMPT, sessionId: 'sess_a' });
    // Another session of the same Project, and the same session of another Project.
    expect((await compose(db, { text: PLANNING_PROMPT, sessionId: 'sess_b' })).parts).toEqual([{ kind: 'plan-nudge' }]);
    expect((await compose(db, { scope: OTHER, text: PLANNING_PROMPT, sessionId: 'sess_a' })).parts).toEqual([{ kind: 'plan-nudge' }]);
    expect(sessionRows(sqlite).map((r) => [r.project_id, r.session_id])).toEqual([
      [SCOPE.projectId, 'sess_a'], [SCOPE.projectId, 'sess_b'], [OTHER.projectId, 'sess_a'],
    ]);
    expect(await recordSessionInjection(db, SCOPE, 'sess_a', 'plan-nudge', NOW)).toBe(false);
    expect(await recordSessionInjection(db, SCOPE, 'sess_a', 'cortex', NOW)).toBe(true);
  });
});

describe('the composed block', () => {
  it('stands the nudge first and the spores after it, joined by a blank line', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a', { observationType: 'decision', content: 'recency is the whole selector' }));
    const served = await compose(db, { text: PLANNING_PROMPT });
    expect(served.context).toBe(`${PLAN_INTENT_NUDGE}\n\nRelevant vault observations:\n- (decision) recency is the whole selector`);
    expect(served.parts).toEqual([{ kind: 'plan-nudge' }, { kind: 'spores', sporeIds: ['a'] }]);
    expect(served.skipped).toEqual([]);
  });

  it('serves the same prompt content nothing a second time', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));
    const first = await compose(db, { promptId: 'p1' });
    expect(first.parts).toEqual([{ kind: 'spores', sporeIds: ['a', 'b'] }]);
    const repeat = await compose(db, { promptId: 'p2' });
    expect(repeat).toEqual({ context: '', parts: [], skipped: [] });
  });

  it('answers an empty block for a Project holding nothing to serve', async () => {
    const { db } = store();
    expect(await compose(db)).toEqual({ context: '', parts: [], skipped: [] });
  });

  it('names a contributor that failed and serves the rest', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('a'));
    sqlite.exec('DROP TABLE spore_injections');
    const served = await compose(db, { text: PLANNING_PROMPT });
    expect(served.skipped).toEqual(['spores']);
    expect(served.context).toBe(PLAN_INTENT_NUDGE);
    expect(served.parts).toEqual([{ kind: 'plan-nudge' }]);
  });
});

describe('the bound', () => {
  it('drops a whole part rather than cutting one mid-line', () => {
    const block = { part: { kind: 'spores' as const, sporeIds: ['a'] }, text: 'x'.repeat(PROMPT_CONTEXT_MAX_CHARS) };
    const nudge = { part: { kind: 'plan-nudge' as const }, text: PLAN_INTENT_NUDGE };

    // The nudge stands first, so the block that would cross the bound is the one dropped.
    expect(partsWithinBound([nudge, block])).toEqual([nudge]);
    // A part that fills the bound exactly is kept whole.
    expect(partsWithinBound([block])).toEqual([block]);
    expect(partsWithinBound([block, nudge])).toEqual([block]);
  });
});

describe('POST /context/prompt', () => {
  const member = async () => {
    const e = sqliteEnv();
    const issuedAt = Date.now();
    const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    e.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(issuedAt);
    e.sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, issuedAt);
    return { e, token: issued.token };
  };
  const admit = (e: ReturnType<typeof sqliteEnv>) =>
    e.sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(NOW);
  const post = (token: string, body: unknown) =>
    new Request('https://s/context/prompt', {
      method: 'POST',
      headers: memberHeaders(token),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('refuses a body it cannot read and one that names no session, prompt or text', async () => {
    const { e, token } = await member();
    for (const body of ['not json', '[]', '{}', { sessionId: 's', promptId: 'p' }, { sessionId: 's', promptId: 'p', text: 42 }, { sessionId: 's', promptId: 'p', text: '' }]) {
      const answer = await (await worker.fetch(post(token, body), e.env)).json() as Record<string, unknown>;
      expect({ body: JSON.stringify(body), persisted: answer.persisted, code: answer.code }).toEqual({ body: JSON.stringify(body), persisted: false, code: 'parse' });
    }
  });

  it('answers the Project that is not admitted an empty block naming the gate', async () => {
    const { e, token } = await member();
    const answer = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }), e.env)).json();
    expect(answer).toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'] });
  });

  it('answers the composed block, its parts, and nothing a second time', async () => {
    const { e, token } = await member();
    admit(e);
    await insertSpore(e.db, { projectId: 'proj_1' }, spore('sp_route', { observationType: 'decision', content: 'the hook answers first' }));

    const first = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }), e.env)).json() as Record<string, unknown>;
    expect(first.persisted).toBe(true);
    expect(first.parts).toEqual([{ kind: 'plan-nudge' }, { kind: 'spores', sporeIds: ['sp_route'] }]);
    expect(String(first.context).startsWith(PLAN_INTENT_NUDGE)).toBe(true);
    expect(String(first.context)).toContain('- (decision) the hook answers first');
    expect(String(first.context).length).toBeLessThanOrEqual(PROMPT_CONTEXT_MAX_CHARS);

    const second = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p2', text: `${PLANNING_PROMPT} once more` }), e.env)).json();
    expect(second).toEqual({ persisted: true, context: '', parts: [], skipped: [] });
  });

  it('keeps one Project\'s records out of another\'s answer', async () => {
    const { e, token } = await member();
    admit(e);
    e.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(NOW);
    e.sqlite.query(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_2', 'cortex', 1, ?, 'test')`).run(NOW);

    const one = new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }) });
    expect(((await (await worker.fetch(one, e.env)).json()) as Record<string, unknown>).parts).toEqual([{ kind: 'plan-nudge' }]);

    const two = new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token, { 'x-myco-project': 'proj_2' }), body: JSON.stringify({ sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }) });
    expect(((await (await worker.fetch(two, e.env)).json()) as Record<string, unknown>).parts).toEqual([{ kind: 'plan-nudge' }]);

    expect(e.sqlite.query(`SELECT project_id FROM session_injections ORDER BY project_id`).all()).toEqual([{ project_id: 'proj_1' }, { project_id: 'proj_2' }]);
  });
});
