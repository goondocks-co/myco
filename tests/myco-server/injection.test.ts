/**
 * Prompt injection: the gates in order, the pool, the two rules the record's
 * primary key holds, and the reads over it.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  AGENT_LINE_MAX_CHARS, estimateTokens, INJECTION_BUDGET_TOKENS, INJECTION_MIN_ITEMS, INJECTION_TARGET_ITEMS,
  injectedPlanIds, injectedSporeIds, injectionForPrompt, injectionLeaves, injectionsForSession,
  itemsWithinBudget, MAX_LINE_TOKENS, MIN_PROMPT_CHARS, renderInjectionContext, selectSporesForPrompt,
  type InjectionItem, type InjectionLeaves,
} from '@myco-server-worker/core/injection.js';
import { insertSpore, type SporeInsert } from '@myco-server-worker/core/spores.js';
import { OBSERVATION_TYPES } from '@myco/vault/types.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';
import { semanticRecall } from './helpers/semantic-recall.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const SESSION = 'sess_1';
const PROMPT = 'what did we decide about the selector';

const ON: InjectionLeaves = { enabled: true, maxPerPrompt: 3 };

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  // Bun enforces foreign keys only when the pragma is issued, so a record that
  // names a project no table holds is refused here as it is on a Deployment.
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
  contentHash: null, properties: null, author: null, createdAt: NOW, ...over,
});

const select = (db: RelationalStore, over: Partial<{ leaves: InjectionLeaves; capabilityOn: boolean; scope: ReadScope; promptId: string; promptHash: string; prompt: string; sessionId: string; now: number }> = {}) =>
  selectSporesForPrompt(db, over.scope ?? SCOPE, over.leaves ?? ON, over.capabilityOn ?? true, {
    sessionId: over.sessionId ?? SESSION,
    promptId: over.promptId ?? 'p1',
    promptHash: over.promptHash ?? 'hash_1',
    prompt: over.prompt ?? PROMPT,
    now: over.now ?? NOW,
  }, semanticRecall(db, over.scope ?? SCOPE));

const rows = (sqlite: Database) => sqlite.query(`SELECT project_id, session_id, prompt_id, prompt_hash, spore_ids, plan_ids, created_at FROM spore_injections`).all() as Record<string, string | number>[];

describe('injection leaves', () => {
  it('defaults an unwritten leaf and clamps the cap to 0..10', () => {
    expect(injectionLeaves({})).toEqual({ enabled: true, maxPerPrompt: 7 });
    expect(injectionLeaves({ 'cortex.spores.inject_on_prompt_submit': false })).toEqual({ enabled: false, maxPerPrompt: 7 });
    expect(injectionLeaves({ 'cortex.spores.max_per_prompt': 0 }).maxPerPrompt).toBe(0);
    expect(injectionLeaves({ 'cortex.spores.max_per_prompt': 40 }).maxPerPrompt).toBe(10);
    expect(injectionLeaves({ 'cortex.spores.max_per_prompt': -3 }).maxPerPrompt).toBe(0);
    expect(injectionLeaves({ 'cortex.spores.max_per_prompt': 'four' }).maxPerPrompt).toBe(7);
  });
});

describe('the gates, in order', () => {
  it('names each gate it closes and writes no record when one closes', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('sp1'));

    expect((await select(db, { capabilityOn: false })).skipped).toBe('capability');
    expect((await select(db, { leaves: { enabled: false, maxPerPrompt: 3 } })).skipped).toBe('disabled');
    expect((await select(db, { prompt: 'x'.repeat(MIN_PROMPT_CHARS - 1) })).skipped).toBe('short_prompt');
    expect((await select(db, { leaves: { enabled: true, maxPerPrompt: 0 } })).skipped).toBe('zero_max');
    expect(rows(sqlite)).toEqual([]);
  });

  it('closes the earlier gate of every adjacent pair, so a swapped order is a failure rather than a silent re-labelling', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('sp1'));
    const short = 'x'.repeat(MIN_PROMPT_CHARS - 1);

    // Capability off and the leaf off: the Project is told it is not admitted.
    expect((await select(db, { capabilityOn: false, leaves: { enabled: false, maxPerPrompt: 3 } })).skipped).toBe('capability');
    // The leaf off and the prompt short: the Deployment's switch answers.
    expect((await select(db, { leaves: { enabled: false, maxPerPrompt: 3 }, prompt: short })).skipped).toBe('disabled');
    // The prompt short and the cap zero: the prompt answers.
    expect((await select(db, { leaves: { enabled: true, maxPerPrompt: 0 }, prompt: short })).skipped).toBe('short_prompt');
    // The cap zero and no spore to serve: the cap answers, and the pool is never read.
    const bare = store();
    expect((await select(bare.db, { leaves: { enabled: true, maxPerPrompt: 0 } })).skipped).toBe('zero_max');
  });

  it('answers the shut gate with no spores and no rendered context', async () => {
    const { db } = store();
    const shut = await select(db, { capabilityOn: false, leaves: { enabled: false, maxPerPrompt: 0 }, prompt: 'hi' });
    expect([shut.skipped, shut.items, shut.context]).toEqual(['capability', [], '']);
  });

  it('answers `empty` with no record when the Project holds no active spore', async () => {
    const { db, sqlite } = store();
    const none = await select(db);
    expect([none.skipped, none.items.length, none.context]).toEqual(['empty', 0, '']);
    expect(rows(sqlite)).toEqual([]);
  });
});

describe('the pool', () => {
  it('serves eligible spores in semantic rank order and never a retired one', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('old', { createdAt: NOW - 3_000 }));
    await insertSpore(db, SCOPE, spore('gone', { createdAt: NOW - 1_000, status: 'superseded' }));
    await insertSpore(db, SCOPE, spore('newest', { createdAt: NOW - 500 }));
    await insertSpore(db, SCOPE, spore('dropped', { createdAt: NOW - 400, status: 'obsolete' }));
    await insertSpore(db, SCOPE, spore('merged', { createdAt: NOW - 300, status: 'consolidated' }));

    const served = await select(db);
    expect(served.items.map((s) => s.id)).toEqual(['newest', 'old']);
    expect(served.skipped).toBeNull();
  });

  it('takes at most the cap the leaf names', async () => {
    const { db } = store();
    for (let i = 0; i < 6; i += 1) await insertSpore(db, SCOPE, spore(`sp${i}`, { createdAt: NOW - i }));
    const served = await select(db, { leaves: { enabled: true, maxPerPrompt: 2 } });
    expect(served.items.map((s) => s.id)).toEqual(['sp0', 'sp1']);
  });

  it('leaves a spore already served in this session out, and the next ranked match takes its place', async () => {
    const { db } = store();
    for (const [id, at] of [['a', NOW - 1], ['b', NOW - 2], ['c', NOW - 3]] as const) {
      await insertSpore(db, SCOPE, spore(id, { createdAt: at }));
    }
    const first = await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p1', promptHash: 'h1' });
    expect(first.items.map((s) => s.id)).toEqual(['a']);
    const second = await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p2', promptHash: 'h2' });
    expect(second.items.map((s) => s.id)).toEqual(['b']);
    const third = await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p3', promptHash: 'h3' });
    expect(third.items.map((s) => s.id)).toEqual(['c']);
    const fourth = await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p4', promptHash: 'h4' });
    expect([fourth.skipped, fourth.items.length]).toEqual(['empty', 0]);
    expect([...(await injectedSporeIds(db, SCOPE, SESSION))].sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the exclusion set to its own session', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('only'));
    await select(db, { sessionId: 'sess_a' });
    const other = await select(db, { sessionId: 'sess_b' });
    expect(other.items.map((s) => s.id)).toEqual(['only']);
    expect([...(await injectedSporeIds(db, SCOPE, 'sess_b'))]).toEqual(['only']);
  });
});

describe('the record', () => {
  it('names the prompt it was served with, and holds one row per prompt content in the session', async () => {
    const { db, sqlite } = store();
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));

    const one: InjectionLeaves = { enabled: true, maxPerPrompt: 1 };
    const first = await select(db, { leaves: one, promptId: 'p1', promptHash: 'same' });
    expect(first.items.map((s) => s.id)).toEqual(['a']);

    // The same prompt content again: the pool still offers `b`, and the key refuses the row.
    const again = await select(db, { leaves: one, promptId: 'p2', promptHash: 'same' });
    expect([again.skipped, again.items.length, again.context]).toEqual(['repeat', 0, '']);

    expect(rows(sqlite)).toEqual([{
      project_id: SCOPE.projectId, session_id: SESSION, prompt_id: 'p1', prompt_hash: 'same',
      spore_ids: JSON.stringify(['a']), plan_ids: JSON.stringify([]), created_at: NOW,
    }]);
  });

  it('reads back per session, newest first, and by prompt with the spores hydrated', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1, observationType: 'decision', content: 'the selector reads relevance' }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));
    await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p1', promptHash: 'h1', now: NOW });
    await select(db, { leaves: { enabled: true, maxPerPrompt: 1 }, promptId: 'p2', promptHash: 'h2', now: NOW + 10 });

    const listed = await injectionsForSession(db, SCOPE, SESSION);
    expect(listed.map((r) => [r.promptId, r.sporeIds, r.createdAt])).toEqual([['p2', ['b'], NOW + 10], ['p1', ['a'], NOW]]);

    const one = await injectionForPrompt(db, SCOPE, SESSION, 'p1');
    expect(one).toEqual({
      sporeIds: ['a'],
      createdAt: NOW,
      spores: [{ id: 'a', observationType: 'decision', preview: 'the selector reads relevance' }],
    });
    expect(await injectionForPrompt(db, SCOPE, SESSION, 'p9')).toBeNull();
  });

  it('is refused for a project no table holds', () => {
    const { sqlite } = store();
    expect(() => sqlite.query(`INSERT INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, created_at)
      VALUES ('proj_absent', 'sess_1', 'p1', 'h1', '[]', 1)`).run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keeps every read inside its Project', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a'));
    await select(db, { promptId: 'p1', promptHash: 'h1' });
    expect(await injectionForPrompt(db, OTHER, SESSION, 'p1')).toBeNull();
    expect(await injectionsForSession(db, OTHER, SESSION)).toEqual([]);
    expect([...(await injectedSporeIds(db, OTHER, SESSION))]).toEqual([]);
    // A record written for one Project does not narrow another Project's pool.
    await insertSpore(db, OTHER, spore('a'));
    const served = await select(db, { scope: OTHER, promptId: 'p1', promptHash: 'h1' });
    expect(served.items.map((s) => s.id)).toEqual(['a']);
  });
});

describe('the rendered context', () => {
  it('names each spore by its type and one line of its observation', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a', { observationType: 'decision', content: 'relevance\nguides the selector', createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { observationType: 'gotcha', content: 'the hook answers first', createdAt: NOW - 2 }));
    const served = await select(db);
    expect(served.context).toBe([
      'Relevant project memory — retrieve any item in full by id:',
      '- [a] (decision) relevance guides the selector',
      '- [b] (gotcha) the hook answers first',
    ].join('\n'));
  });

  /**
   * The record names what the block rendered, not what the selector picked.
   *
   * A record naming more than the agent saw counts an observation as served
   * that never reached it, and the session-wide exclusion set then withholds it
   * from every later prompt of the session.
   */
  it('stops at the budget, and records exactly the items it rendered', async () => {
    const { db, sqlite } = store();
    const long = 'x'.repeat(INJECTION_BUDGET_TOKENS * 4);
    for (let i = 0; i < 10; i += 1) await insertSpore(db, SCOPE, spore(`sp${i}`, { content: long, createdAt: NOW - i }));
    const served = await select(db, { leaves: { enabled: true, maxPerPrompt: 10 } });
    const lines = served.context.split('\n- ').length - 1;
    expect(lines).toBe(served.items.length);
    expect(estimateTokens(served.context)).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
    expect(JSON.parse(rows(sqlite)[0]!.spore_ids as string)).toEqual(served.items.map((i) => i.id));
  });
});


/**
 * The budget arithmetic, asserted as an inequality rather than as numbers.
 *
 * The caps are derived from the ceiling and the item floor, so a change to
 * either has to keep the floor's worth of full-length lines inside the budget.
 * Asserting the constants themselves would pass a change that quietly served
 * four items where the issue's gate demands five.
 *
 * This proves the arithmetic under `estimateTokens`, which is four characters
 * to a token. It bounds what the renderer emits, not what a model counts.
 */
describe('the injection budget', () => {
  it('fits the item floor at the full line cap', () => {
    const header = 'Relevant project memory — retrieve any item in full by id:';
    const search = 'More may match — search with myco_search.';
    const fixed = estimateTokens(header) + estimateTokens(`\n${search}`);
    expect(INJECTION_MIN_ITEMS * MAX_LINE_TOKENS + fixed).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
  });

  it('leaves an item line long enough to carry a trigger and its guidance', () => {
    expect(estimateTokens('x'.repeat(AGENT_LINE_MAX_CHARS))).toBeGreaterThanOrEqual(35);
  });

  it('serves the floor and never more than the ceiling', () => {
    const item = (n: number): InjectionItem => ({ kind: 'spore', id: `spr_${n}`, label: 'gotcha', text: 'g'.repeat(AGENT_LINE_MAX_CHARS) });
    const many = Array.from({ length: 20 }, (_, i) => item(i));
    const served = itemsWithinBudget(many);
    expect(served.length).toBeGreaterThanOrEqual(INJECTION_MIN_ITEMS);
    expect(served.length).toBeLessThanOrEqual(INJECTION_TARGET_ITEMS);
    expect(estimateTokens(renderInjectionContext(served, true))).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
  });

  /**
   * The per-line cap is derived against the widest prefix the renderer emits.
   * A longer observation type than the one assumed would spend budget the cap
   * did not account for, and the shortfall would show up as fewer items served.
   */
  it('assumes a label at least as wide as any observation type', () => {
    const widest = [...OBSERVATION_TYPES].sort((a, b) => b.length - a.length)[0]!;
    expect(widest.length).toBeLessThanOrEqual('plan: in_progress'.length);
  });

  it('carries every item id, so an agent can fetch one in full', () => {
    const items: InjectionItem[] = [
      { kind: 'spore', id: 'spr_a', label: 'gotcha', text: 'the selector drops the tail' },
      { kind: 'plan', id: 'plan_b', label: 'plan: in_progress', text: 'serving rewrite' },
    ];
    const lines = renderInjectionContext(items, false).split('\n').slice(1);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^- \[[A-Za-z0-9_-]+\] \(/);
  });

  it('names the search tool only where the pool held more than it served', () => {
    const one: InjectionItem[] = [{ kind: 'spore', id: 'spr_a', label: 'gotcha', text: 'one' }];
    expect(renderInjectionContext(one, true)).toContain('myco_search');
    expect(renderInjectionContext(one, false)).not.toContain('myco_search');
    expect(renderInjectionContext([], true)).toBe('');
  });

  /**
   * A plan key is a path and can run far past the id length the text cap is
   * derived against. Its line then costs more than one share of the budget,
   * which must spend that plan's place rather than the block's ceiling.
   */
  it('keeps the ceiling when a plan key runs long', () => {
    const long = 'g'.repeat(AGENT_LINE_MAX_CHARS);
    const items: InjectionItem[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'spore' as const, id: `spr_${i}`, label: 'gotcha', text: long })),
      { kind: 'plan', id: `path:${'deep/'.repeat(30)}plan.md`, label: 'plan: in_progress', text: long },
    ];
    const served = itemsWithinBudget(items);
    expect(estimateTokens(renderInjectionContext(served, true))).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
  });

  it('drops plans before spores and the weakest score last', () => {
    const long = 'g'.repeat(AGENT_LINE_MAX_CHARS);
    const ordered: InjectionItem[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'spore' as const, id: `spr_${i}`, label: 'gotcha', text: long })),
      { kind: 'plan', id: 'plan_z', label: 'plan: active', text: long },
    ];
    const served = itemsWithinBudget(ordered);
    expect(served.every((i) => i.kind === 'spore')).toBe(true);
  });
});
