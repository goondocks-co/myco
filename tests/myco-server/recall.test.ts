/**
 * Recall: the capability gate over everything, the contributors and the order
 * they stand in, the once-per-session records, the bounds at a part boundary,
 * and the two routes that serve them.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import {
  composePromptContext, composeSessionContext, detectsPlanIntent, partsWithinBound, projectLine,
  PLAN_INTENT_NUDGE, PROMPT_CONTEXT_MAX_CHARS, recallLeaves, recordSessionInjection,
  SESSION_CONTEXT_MAX_CHARS, sessionInjectionKind, SUBAGENT_CORTEX_GUIDANCE,
  PROMPT_ANSWER_RETENTION_DAYS, PROMPT_ANSWER_RETENTION_SQL,
  type Contribution, type RecallLeaves, type RecallSkip, type SessionContextKind,
} from '@myco-server-worker/core/recall.js';
import { INSTRUCTIONS_TEMPLATE_LEAF, settingsWriter } from '@myco-server-worker/core/settings.js';
import { insertSpore, type SporeInsert } from '@myco-server-worker/core/spores.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { semanticRecall } from './helpers/semantic-recall.js';
import { indexFixture } from './helpers/vector-index.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { planKeyForPath } from '@myco/member/envelope.js';
import { normalizePlanPath } from '@myco/member/plan-files.js';
import { vectorNamespace } from '@myco-server-worker/core/embedding/vectors.js';
import { classifyD1Error } from '@myco-server-worker/platform/cloudflare/env.js';
import { emptyInjectionCounts, type InjectionCounts } from '@myco-server-worker/core/injection.js';
import { EmbeddingUnavailable } from '@myco-server-worker/core/embedding/provider.js';
import * as plans from '@myco-server-worker/read/plans.js';
import { agentRunRetention, JOB_BATCH } from '@myco-server-worker/core/jobs-run.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { WAKE_JOB_STATEMENT_LIMIT } from '@myco-server-worker/core/tick.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const SESSION = 'sess_1';
/** Plain enough to carry no planning intent, long enough to clear the selector's floor. */
const PROMPT = 'what did we settle on for the selector';
const PLANNING_PROMPT = 'let us write the implementation plan for the selector';

const TEMPLATE = '# Project guidance\nKeep the plan current.';

const ON: RecallLeaves = {
  injection: { enabled: true, maxPerPrompt: 3 },
  planNudge: true,
  instructionsAtSessionStart: true,
  instructionsAtSubagentStart: true,
  instructionsTemplate: TEMPLATE,
};

/** The Project line every session start carries, whatever else it does. */
const PROJECT_LINE = projectLine(SCOPE.projectId);

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
  contentHash: null, properties: null, author: null, createdAt: NOW, ...over,
});

const compose = (
  db: RelationalStore,
  over: Partial<{ leaves: RecallLeaves; capabilityOn: boolean; scope: ReadScope; sessionId: string; promptId: string; text: string; now: number }> = {},
) => composePromptContext(db, over.scope ?? SCOPE, over.leaves ?? ON, over.capabilityOn ?? true, {
  sessionId: over.sessionId ?? SESSION,
  promptId: over.promptId ?? 'p1',
  text: over.text ?? PROMPT,
  now: over.now ?? NOW,
}, semanticRecall(db, over.scope ?? SCOPE));

const sessionRows = (sqlite: Database) =>
  sqlite.query(`SELECT project_id, session_id, kind, created_at FROM session_injections`).all() as Record<string, string | number>[];

describe('the recall leaves', () => {
  it('defaults the nudge on and carries the injection leaves through', () => {
    expect(recallLeaves({})).toEqual({ ...ON, injection: { enabled: true, maxPerPrompt: 7 }, instructionsTemplate: '' });
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': false }).planNudge).toBe(false);
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': 'yes' }).planNudge).toBe(true);
    expect(recallLeaves({ 'cortex.spores.max_per_prompt': 1 }).injection.maxPerPrompt).toBe(1);
  });

  it('starts a session with the template and without any generated artifact', () => {
    expect(recallLeaves({})).toMatchObject({
      instructionsAtSessionStart: true, instructionsAtSubagentStart: true, instructionsTemplate: '',
    });
    expect(recallLeaves({ 'instructions.template': '# hi' }).instructionsTemplate).toBe('# hi');
    expect(recallLeaves({ 'cortex.instructions.inject_on_session_start': false }).instructionsAtSessionStart).toBe(false);
    expect(recallLeaves({ 'cortex.instructions.inject_on_subagent_start': false }).instructionsAtSubagentStart).toBe(false);
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
    const sporesOff: RecallLeaves = { ...ON, injection: { enabled: false, maxPerPrompt: 3 } };

    const first = await compose(db, { leaves: sporesOff, text: PLANNING_PROMPT, promptId: 'p1' });
    expect(first.context).toBe(PLAN_INTENT_NUDGE);
    expect(first.parts).toEqual([{ kind: 'plan-nudge' }]);
    expect(first.skipped).toEqual(['spores:disabled']);

    const again = await compose(db, { leaves: sporesOff, text: `${PLANNING_PROMPT} again`, promptId: 'p2' });
    expect(again).toEqual({ context: '', parts: [], skipped: ['spores:disabled', 'plan-nudge:repeat'] });

    expect(sessionRows(sqlite)).toEqual([{ project_id: SCOPE.projectId, session_id: SESSION, kind: 'plan-nudge', created_at: NOW }]);
  });

  it('names why it stayed silent: no intent in the prompt, or a Deployment that switched it off', async () => {
    const { db, sqlite } = store();
    expect((await compose(db, { text: PROMPT })).skipped).toEqual(['spores:empty', 'plan-nudge:no_intent']);
    const nudgeOff: RecallLeaves = { ...ON, injection: { enabled: false, maxPerPrompt: 3 }, planNudge: false };
    expect((await compose(db, { leaves: nudgeOff, text: PLANNING_PROMPT })).skipped).toEqual(['spores:disabled', 'plan-nudge:off']);
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
    expect(served.context).toBe(`${PLAN_INTENT_NUDGE}\n\nRelevant project memory — retrieve any item in full by id:\n- [a] (decision) recency is the whole selector`);
    expect(served.parts).toEqual([{ kind: 'plan-nudge' }, { kind: 'spores', sporeIds: ['a'], planIds: [] }]);
    expect(served.skipped).toEqual([]);
  });

  it('serves the same prompt content nothing a second time', async () => {
    const { db } = store();
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));
    const first = await compose(db, { promptId: 'p1' });
    expect(first.parts).toEqual([{ kind: 'spores', sporeIds: ['a', 'b'], planIds: [] }]);
    const repeat = await compose(db, { promptId: 'p2' });
    expect(repeat).toEqual({ context: '', parts: [], skipped: ['spores:empty', 'plan-nudge:no_intent'] });
  });

  it('names the record\'s own gate when the pool still holds a spore the prompt content already spent', async () => {
    const { db } = store();
    const one: RecallLeaves = { ...ON, injection: { enabled: true, maxPerPrompt: 1 }, planNudge: true };
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));
    expect((await compose(db, { leaves: one, promptId: 'p1' })).parts).toEqual([{ kind: 'spores', sporeIds: ['a'], planIds: [] }]);
    // `b` is still in the pool; the record's key is what closes on the second call.
    expect((await compose(db, { leaves: one, promptId: 'p2' })).skipped).toEqual(['spores:repeat', 'plan-nudge:no_intent']);
  });

  it('answers an empty block for a Project holding nothing to serve', async () => {
    const { db } = store();
    expect(await compose(db)).toEqual({ context: '', parts: [], skipped: ['spores:empty', 'plan-nudge:no_intent'] });
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

  it('records a contributor throw under its prompt and emits its coded cause', async () => {
    const { db, sqlite } = store();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const answer = await composePromptContext(db, OTHER, ON, true, { sessionId: SESSION, promptId: 'failed', text: PROMPT, now: NOW }, async () => { throw new RangeError('private provider text'); });
      expect(answer).toEqual({ context: '', parts: [], skipped: ['spores', 'plan-nudge:no_intent'] });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ kind: 'recall_contributor_failed', projectId: OTHER.projectId, sessionId: SESSION, promptId: 'failed', contributor: 'spores', error: 'parse', operation: 'embed' });
      const rows = sqlite.query('SELECT project_id, session_id, prompt_id, outcome, context_chars, parts, skipped, failures FROM prompt_context_answers').all();
      expect(rows).toEqual([{ project_id: OTHER.projectId, session_id: SESSION, prompt_id: 'failed', outcome: 'empty', context_chars: 0, parts: '[]', skipped: JSON.stringify(answer.skipped), failures: JSON.stringify([{ contributor: 'spores', error: 'parse', operation: 'embed' }]) }]);
      expect(JSON.stringify(rows)).not.toContain('private provider text');
      expect(JSON.stringify(log.mock.calls)).not.toContain('private provider text');
    } finally { log.mockRestore(); sqlite.close(); }
  });

  it('preserves the platform error classification in contributor events and prompt records', async () => {
    const { db, sqlite } = store();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await composePromptContext(db, OTHER, ON, true, { sessionId: SESSION, promptId: 'quota', text: PROMPT, now: NOW }, async () => {
        throw new Error("D1_ERROR: exceeded D1's free tier daily row read limit");
      }, classifyD1Error);
      expect(sqlite.query('SELECT failures FROM prompt_context_answers').get()).toEqual({ failures: '[{"contributor":"spores","error":"store_quota","operation":"embed"}]' });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        kind: 'recall_contributor_failed', projectId: OTHER.projectId, sessionId: SESSION, promptId: 'quota', contributor: 'spores', error: 'store_quota', operation: 'embed',
      });
    } finally { log.mockRestore(); sqlite.close(); }
  });

  it('keeps every answer attempt, including capability refusals and repeat gates, queryable under its prompt', async () => {
    const { db, sqlite } = store();
    try {
      await compose(db, { capabilityOn: false });
      await compose(db, { text: PLANNING_PROMPT });
      await compose(db, { text: PLANNING_PROMPT });
      const rows = sqlite.query('SELECT outcome, skipped FROM prompt_context_answers WHERE project_id = ? AND session_id = ? AND prompt_id = ? ORDER BY rowid').all(SCOPE.projectId, SESSION, 'p1');
      expect(rows).toEqual([
        { outcome: 'empty', skipped: '["capability"]' },
        { outcome: 'served', skipped: '["spores:empty"]' },
        { outcome: 'empty', skipped: '["spores:empty","plan-nudge:repeat"]' },
      ]);
    } finally { sqlite.close(); }
  });

  it('records an injection INSERT failure with its operation under the affected prompt', async () => {
    const { db, sqlite } = store();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await insertSpore(db, OTHER, spore('other'));
      sqlite.exec(`CREATE TRIGGER injection_unavailable BEFORE INSERT ON spore_injections
        WHEN NEW.project_id = 'proj_two' BEGIN SELECT RAISE(ABORT, 'fixture constraint failed'); END`);
      const answer = await compose(db, { scope: OTHER });
      expect(answer).toEqual({ context: '', parts: [], skipped: ['spores', 'plan-nudge:no_intent'] });
      expect(sqlite.query('SELECT project_id, failures FROM prompt_context_answers').all()).toEqual([
        { project_id: OTHER.projectId, failures: '[{"contributor":"spores","error":"constraint","operation":"record"}]' },
      ]);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        kind: 'recall_contributor_failed', projectId: OTHER.projectId, sessionId: SESSION, promptId: 'p1',
        contributor: 'spores', error: 'constraint', operation: 'record',
      });
    } finally { log.mockRestore(); sqlite.close(); }
  });

  it('serves committed context and reports a failed answer journal write', async () => {
    const { db, sqlite } = store();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await insertSpore(db, SCOPE, spore('a'));
      sqlite.exec(`CREATE TRIGGER journal_unavailable BEFORE INSERT ON prompt_context_answers BEGIN SELECT RAISE(ABORT, 'fixture constraint failed'); END`);
      const served = await compose(db);
      expect(served.context).toContain('content of a');
      expect(sqlite.query('SELECT COUNT(*) AS n FROM spore_injections').get()).toEqual({ n: 1 });
      expect(sqlite.query('SELECT COUNT(*) AS n FROM prompt_context_answers').get()).toEqual({ n: 0 });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ kind: 'recall_answer_unrecorded', projectId: SCOPE.projectId, sessionId: SESSION, promptId: 'p1', error: 'constraint' });
    } finally { log.mockRestore(); sqlite.close(); }
  });
});

describe('prompt selection diagnostics', () => {
  const seedPlan = (sqlite: Database) => sqlite.query(`INSERT INTO plans
    (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at, origin_path)
    VALUES (?, 'plan-key', 'history', 'event-plan', 'machine', 'controller plan', 'controller evidence', 'hash', 'active', ?, ?, 'fixture', ?, 'plan.md')`)
    .run(SCOPE.projectId, NOW, NOW, NOW);
  const selectionOf = (sqlite: Database, promptId: string): InjectionCounts => JSON.parse((sqlite.query('SELECT selection FROM prompt_context_answers WHERE prompt_id = ?').get(promptId) as { selection: string }).selection);

  it('distinguishes no matches, stale receipt revisions and null plan hydration in stored rows', async () => {
    const { db, sqlite } = store();
    seedPlan(sqlite);
    const semantic = await semanticRecall(db, SCOPE)();
    const query = semantic.vectors.query;
    semantic.vectors.query = async (partition, options) => (await query(partition, options)).map(hit =>
      options.filters?.type === 'plan' ? { ...hit, score: 0.95 } : hit);
    const ask = (promptId: string, resolve = async () => semantic) => composePromptContext(db, SCOPE, ON, true, { sessionId: SESSION, promptId, text: PROMPT, now: NOW }, resolve);
    try {
      await ask('no-hits', async () => ({ ...semantic, vectors: { ...semantic.vectors, query: async () => [] } }));
      expect(selectionOf(sqlite, 'no-hits')).toEqual(emptyInjectionCounts());
      const nullPlan = spyOn(plans, 'getPlan').mockResolvedValue(null);
      try { await ask('null-plan'); expect(nullPlan).toHaveBeenCalledTimes(1); } finally { nullPlan.mockRestore(); }
      const missing = selectionOf(sqlite, 'null-plan');
      expect(missing).toMatchObject({ planRawMatches: 1, planJoined: 1, planHits: 1, planUnserved: 1, planHydrated: 0, budgetKept: 0 });
      expect(missing).not.toEqual(selectionOf(sqlite, 'no-hits'));
      sqlite.exec("UPDATE embedding_receipts SET revision = 'stale'");
      await ask('stale');
      const stale = selectionOf(sqlite, 'stale');
      expect(stale).toMatchObject({ planRawMatches: 1, planJoined: 0, planHits: 0, planUnserved: 0, planHydrated: 0, budgetKept: 0 });
      expect(stale).not.toEqual(missing);
    } finally { sqlite.close(); }
  });

  it('counts metadata post-filter rejection independently of the receipt join', async () => {
    const { db, sqlite } = store();
    seedPlan(sqlite);
    const semantic = await semanticRecall(db, SCOPE)();
    try {
      await composePromptContext(db, SCOPE, ON, true, { sessionId: SESSION, promptId: 'metadata', text: PROMPT, now: NOW }, async () => ({
        ...semantic, vectors: { ...semantic.vectors, query: (partition, options) => semantic.vectors.query(partition, { ...options, filters: { type: 'plan' } }) },
      }));
      expect(selectionOf(sqlite, 'metadata')).toMatchObject({ sporeRawMatches: 1, sporeJoined: 1, sporeHits: 0, sporeCalibrated: 0, sporeScored: 0, sporeRelevant: 0, planHits: 1, planEligible: 1, planCalibrated: 0, planScored: 1, planRelevant: 0, planHydrated: 0, budgetKept: 0 });
      expect(sqlite.query('SELECT parts FROM prompt_context_answers').get()).toEqual({ parts: '[]' });
    } finally { sqlite.close(); }
  });

  it('preserves completed receipt chunks when a later join throws', async () => {
    const { db, sqlite } = store();
    for (let i = 0; i < 100; i++) await insertSpore(db, SCOPE, spore(`chunk-${i}`));
    const semantic = await semanticRecall(db, SCOPE)();
    let joins = 0;
    const wrap = (statement: PreparedStatement): PreparedStatement => ({
      ...statement,
      bind: (...values) => wrap(statement.bind(...values)),
      all: async <T,>() => {
        if (++joins === 2) throw new Error('receipt chunk unavailable');
        return statement.all<T>();
      },
    });
    const failingDb: RelationalStore = { ...db, prepare: sql => {
      const statement = db.prepare(sql);
      return sql.includes('JOIN embedding_sources s') ? wrap(statement) : statement;
    } };
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await composePromptContext(failingDb, SCOPE, ON, true, { sessionId: SESSION, promptId: 'partial-join', text: PROMPT, now: NOW }, async () => semantic);
      expect(selectionOf(sqlite, 'partial-join')).toMatchObject({ sporeRawMatches: 100, sporeJoined: 90, sporeHits: 90, sporeHydrated: 0, budgetKept: 0 });
      expect(sqlite.query('SELECT failures FROM prompt_context_answers').get()).toEqual({ failures: '[{"contributor":"spores","error":"unknown","operation":"candidates"}]' });
    } finally { log.mockRestore(); sqlite.close(); }
  });

  it('separates missing semantic configuration, provider unavailability and unexpected embed throws', async () => {
    const { db, sqlite } = store();
    const semantic = await semanticRecall(db, SCOPE)();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const input = { sessionId: SESSION, text: PROMPT, now: NOW };
      expect((await composePromptContext(db, SCOPE, ON, true, { ...input, promptId: 'unconfigured' }, async () => null)).skipped).toContain('spores:no_semantic');
      expect((await composePromptContext(db, SCOPE, ON, true, { ...input, promptId: 'unavailable' }, async () => ({ ...semantic, provider: { ...semantic.provider, embed: async () => { throw new EmbeddingUnavailable('private provider text'); } } }))).skipped).toContain('spores:provider_unavailable');
      await composePromptContext(db, SCOPE, ON, true, { ...input, promptId: 'throw' }, async () => ({ ...semantic, provider: { ...semantic.provider, embed: async () => { throw new RangeError('private provider text'); } } }));
      expect(sqlite.query("SELECT failures FROM prompt_context_answers WHERE prompt_id = 'throw'").get()).toEqual({ failures: '[{"contributor":"spores","error":"parse","operation":"embed"}]' });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ kind: 'recall_contributor_failed', projectId: SCOPE.projectId, sessionId: SESSION, promptId: 'throw', contributor: 'spores', error: 'parse', operation: 'embed' });
    } finally { log.mockRestore(); sqlite.close(); }
  });

  it('uses the platform classifier for a session contributor too', async () => {
    const { db, sqlite } = store();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const leaves = { ...ON, get instructionsTemplate(): string { throw new Error("D1_ERROR: exceeded D1's free tier daily row read limit"); } };
      await composeSessionContext(db, SCOPE, leaves, true, { sessionId: SESSION, kind: 'start', now: NOW }, { preview: true, classifyError: classifyD1Error });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ kind: 'recall_contributor_failed', projectId: SCOPE.projectId, sessionId: SESSION, contributor: 'instructions', error: 'store_quota' });
    } finally { log.mockRestore(); sqlite.close(); }
  });
});

describe('prompt answer retention', () => {
  it('sweeps 30-day diagnostics through the scheduled retention job in indexed rowid batches of 500', async () => {
    const e = sqliteEnv();
    const cutoff = NOW - PROMPT_ANSWER_RETENTION_DAYS * 86_400_000;
    const insert = e.sqlite.query(`INSERT INTO prompt_context_answers (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
      VALUES (?, 'uncaptured', 'prompt', ?, 'empty', 0, '[]', '[]', '[]', ?, ?)`);
    try {
      for (const project of ['proj_1', 'proj_2']) {
        for (let i = 0; i < (project === 'proj_1' ? JOB_BATCH + 1 : 2); i++) insert.run(project, `old-${i}`, JSON.stringify(emptyInjectionCounts()), cutoff - 1);
        for (const at of [cutoff, NOW]) insert.run(project, `kept-${at}`, JSON.stringify(emptyInjectionCounts()), at);
      }
      const plan = e.sqlite.query(`EXPLAIN QUERY PLAN ${PROMPT_ANSWER_RETENTION_SQL}`).all(cutoff, JOB_BATCH);
      expect(JSON.stringify(plan)).toContain('USING COVERING INDEX idx_prompt_context_answers_created (project_id=? AND created_at<?)');
      expect(JSON.stringify(plan)).not.toContain('SCAN prompt_context_answers');
      expect(await agentRunRetention(e.serverEnv, NOW)).toBe(JOB_BATCH);
      expect(await agentRunRetention(e.serverEnv, NOW)).toBe(3);
      expect(await agentRunRetention(e.serverEnv, NOW)).toBe(0);
      expect(e.sqlite.query('SELECT project_id, created_at FROM prompt_context_answers ORDER BY project_id, created_at').all()).toEqual([
        { project_id: 'proj_1', created_at: cutoff }, { project_id: 'proj_1', created_at: NOW },
        { project_id: 'proj_2', created_at: cutoff }, { project_id: 'proj_2', created_at: NOW },
      ]);
    } finally { e.sqlite.close(); }
  });

  it('reaches expired answers beyond many empty Projects within the wake statement budget', async () => {
    const e = sqliteEnv();
    try {
      const project = e.sqlite.query('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)');
      for (let i = 0; i < WAKE_JOB_STATEMENT_LIMIT + 1; i++) project.run(`empty-${i}`, 'empty', NOW);
      project.run('zz-last', 'last', NOW);
      e.sqlite.query(`INSERT INTO prompt_context_answers (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
        VALUES ('zz-last', 's', 'p', 'a', 'empty', 0, '[]', '[]', '[]', ?, 0)`).run(JSON.stringify(emptyInjectionCounts()));
      const measured = measuredContentEnv(e.serverEnv, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: 0 });
      expect(await agentRunRetention(measured.env, NOW)).toBe(1);
      expect(measured.usage.statements).toBeLessThan(10);
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM prompt_context_answers').get()).toEqual({ n: 0 });
    } finally { e.sqlite.close(); }
  });
});

describe('the bound', () => {
  it('drops a whole part rather than cutting one mid-line', () => {
    type Part = { kind: 'spores'; sporeIds: string[] } | { kind: 'plan-nudge' };
    const block: Contribution<Part> = { part: { kind: 'spores', sporeIds: ['a'] }, text: 'x'.repeat(PROMPT_CONTEXT_MAX_CHARS) };
    const nudge: Contribution<Part> = { part: { kind: 'plan-nudge' }, text: PLAN_INTENT_NUDGE };

    // The nudge stands first, so the block that would cross the bound is the one dropped.
    expect(partsWithinBound([nudge, block])).toEqual([nudge]);
    // A part that fills the bound exactly is kept whole.
    expect(partsWithinBound([block])).toEqual([block]);
    expect(partsWithinBound([block, nudge])).toEqual([block]);
  });
});


// ---------------------------------------------------------------------------
// Session start and subagent start
// ---------------------------------------------------------------------------

const forSession = (
  db: RelationalStore,
  over: Partial<{ leaves: RecallLeaves; capabilityOn: boolean; scope: ReadScope; sessionId: string; kind: SessionContextKind; agentId: string; agentType: string; compaction: number; now: number }> = {},
) => composeSessionContext(db, over.scope ?? SCOPE, over.leaves ?? ON, over.capabilityOn ?? true, {
  sessionId: over.sessionId ?? SESSION,
  ...(over.kind === 'compact' ? { kind: 'compact' as const, compaction: over.compaction ?? 1 } : { kind: over.kind ?? 'start' }),
  agentId: over.agentId,
  agentType: over.agentType,
  now: over.now ?? NOW,
});

/** An empty block for a start, with the gates it closed on. */
const emptyStart = (skipped: RecallSkip[]) => ({ context: '', parts: [], skipped, kind: 'cortex' });


describe('a session start', () => {
  it('names the Project first, then serves the template with no heading of its own', async () => {
    const { db, sqlite } = store();
    const served = await forSession(db);
    expect(served.context).toBe(`${PROJECT_LINE}\n\n${TEMPLATE}`);
    expect(served.parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
    expect(served.skipped).toEqual([]);
    expect(served.kind).toBe('cortex');
    expect(sessionRows(sqlite)).toEqual([{ project_id: SCOPE.projectId, session_id: SESSION, kind: 'cortex', created_at: NOW }]);
  });

  /**
   * The Project id is the value a write is refused without, so an agent is told
   * it whatever else the Deployment holds back.
   */
  it('names the Project even where the Deployment holds a template of its own back', async () => {
    const { db, sqlite } = store();
    const off = await forSession(db, { leaves: { ...ON, instructionsAtSessionStart: false } });
    expect(off.context).toBe(PROJECT_LINE);
    expect(off.parts).toEqual([{ kind: 'project' }]);
    expect(off.skipped).toEqual(['instructions:off']);

    const empty = await forSession(store().db, { leaves: { ...ON, instructionsTemplate: '   ' } });
    expect(empty.context).toBe(PROJECT_LINE);
    expect(empty.skipped).toEqual(['instructions:empty']);
    expect(sessionRows(sqlite)).toHaveLength(1);
  });

  it('serves nothing a second time and names the record standing', async () => {
    const { db, sqlite } = store();
    expect((await forSession(db)).parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
    expect(await forSession(db)).toEqual(emptyStart(['repeat']));
    expect(sessionRows(sqlite)).toHaveLength(1);
  });

  /**
   * The capability holds back what the Deployment generates and stores. It does
   * not hold back the Project id: a write is refused without it, so a Project
   * that is not admitted still has to be told what its writes must name.
   */
  it('names the Project even where the Project is not admitted to cortex', async () => {
    const { db, sqlite } = store();
    const served = await forSession(db, { capabilityOn: false });
    expect(served.context).toBe(PROJECT_LINE);
    expect(served.parts).toEqual([{ kind: 'project' }]);
    expect(served.skipped).toEqual(['capability']);
    expect(sessionRows(sqlite)).toHaveLength(1);
  });
});


describe('a subagent start', () => {
  it('hands the delegated agent the guidance lines above the instructions', async () => {
    const { db, sqlite } = store();
    const served = await forSession(db, { kind: 'subagent', agentType: 'code-reviewer' });
    expect(served.context).toBe(`${PROJECT_LINE}\n\n${SUBAGENT_CORTEX_GUIDANCE}\n\n${TEMPLATE}`);
    expect(served.context.split('\n').slice(2, 5)).toEqual([
      'You are a delegated subagent working inside a Myco-connected project.',
      'Follow these managed Cortex instructions as current project guidance.',
      'Apply them to your assigned task, and defer broad orchestration decisions back to the parent agent.',
    ]);
    expect(served.parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
  });

  it('is served the Project line and the template, and nothing generated', async () => {
    const { db } = store();
    const served = await forSession(db, { kind: 'subagent', agentType: 'code-reviewer', leaves: { ...ON } });
    expect(served.parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
    expect(served.context).toBe(`${PROJECT_LINE}\n\n${SUBAGENT_CORTEX_GUIDANCE}\n\n${TEMPLATE}`);
  });

  it('serves every delegation, keyed on its own id, and the session start beside them', async () => {
    const { db, sqlite } = store();
    // Two delegations of one type are two subagents, and each is served.
    for (const agentId of ['a1', 'a2']) {
      const served = await forSession(db, { kind: 'subagent', agentId, agentType: 'code-reviewer' });
      expect({ agentId, parts: served.parts, kind: served.kind })
        .toEqual({ agentId, parts: [{ kind: 'project' }, { kind: 'instructions' }], kind: `cortex:${agentId}` });
    }
    // The same delegation twice is one subagent.
    expect(await forSession(db, { kind: 'subagent', agentId: 'a1', agentType: 'code-reviewer' }))
      .toEqual({ context: '', parts: [], skipped: ['repeat'], kind: 'cortex:a1' });
    // A harness naming no id falls to the type, and one naming neither to a single name.
    expect((await forSession(db, { kind: 'subagent', agentType: 'explorer' })).kind).toBe('cortex:explorer');
    expect((await forSession(db, { kind: 'subagent' })).kind).toBe('cortex:unknown');
    expect((await forSession(db, { kind: 'start' })).parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
    expect(sessionRows(sqlite).map((r) => r.kind))
      .toEqual(['cortex:a1', 'cortex:a2', 'cortex:explorer', 'cortex:unknown', 'cortex']);
  });

  it('names the delegation the way the record does, trimming what the harness sent', () => {
    expect(sessionInjectionKind({ kind: 'start', agentId: 'a1', agentType: 'code-reviewer' })).toBe('cortex');
    expect(sessionInjectionKind({ kind: 'subagent', agentId: ' a1 ', agentType: 'code-reviewer' })).toBe('cortex:a1');
    expect(sessionInjectionKind({ kind: 'subagent', agentId: '  ', agentType: ' code-reviewer ' })).toBe('cortex:code-reviewer');
    expect(sessionInjectionKind({ kind: 'subagent' })).toBe('cortex:unknown');
  });

  it('holds the instructions back where the Deployment switched the subagent surface off', async () => {
    const { db, sqlite } = store();
    expect(await forSession(db, { kind: 'subagent', agentType: 'code-reviewer', leaves: { ...ON, instructionsAtSubagentStart: false } }))
      .toEqual({ context: PROJECT_LINE, parts: [{ kind: 'project' }], skipped: ['instructions:off'], kind: 'cortex:code-reviewer' });
    // The session-start surface is a different switch and stays on.
    expect((await forSession(db, { leaves: { ...ON, instructionsAtSubagentStart: false } })).parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
  });
});

describe('the session bound', () => {
  /**
   * The Project line survives whatever else the bound drops: it is one short
   * line, and it is the value a write is refused without.
   */
  it('drops a whole part rather than cutting one mid-line, and keeps the Project line', async () => {
    const { db, sqlite } = store();
    const served = await forSession(db, { leaves: { ...ON, instructionsTemplate: 'x'.repeat(SESSION_CONTEXT_MAX_CHARS) } });
    expect(served.parts).toEqual([{ kind: 'project' }]);
    expect(served.context).toBe(PROJECT_LINE);
    expect(sessionRows(sqlite)).toHaveLength(1);
  });
});

describe('POST /context/prompt', () => {
  it.each([false, true])('serves relevant memory for two populated Projects on one Deployment (legacy-only B: %s)', async (legacyOnly) => {
    const e = sqliteEnv();
    const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [AGENT, NOW]);
    e.env.AI = { run: async (_model: string, input: { text: string[] }) => ({ data: input.text.map((text) => text.includes('background') ? [0, 1] : text.includes('plan') ? [1, 0] : text.includes('network') ? (legacyOnly ? [1, 0] : [0.6, 0.8]) : [1, 0]) }) };
    if (legacyOnly) await settingsWriter(e.db).setLeaf('cortex.spores.max_per_prompt', 3, 'mem_machine_1', NOW);
    const planKeys = new Map<string, Set<string>>();
    const index = indexFixture();
    const namespaces: string[] = [];
    e.env.VECTORIZE = { ...index, query: async (...args: Parameters<typeof index.query>) => { namespaces.push(args[1].namespace); return index.query(...args); } };
    try {
      for (const [projectId, name, count, plans] of [['proj_1', 'myco', 30, 4], ['proj_2', 'unifi-mcp', 453, 112]] as const) {
        e.sqlite.run(`UPDATE projects SET name = ? WHERE project_id = ?`, [name, projectId]);

        for (let i = 0; i < 45; i++) e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, origin_path, started_at)
          VALUES (?, ?, 'machine_1', 'fixture', ?, ?, ?, ?)`, [projectId, `history-${i}`, NOW - i, NOW, `/Users/fixture/Repos/${name}`, NOW - i]);
        planKeys.set(projectId, new Set());
        const imported = (i: number) => legacyOnly && (projectId === 'proj_2' || i % 2 === 0);
        for (let i = 0; i < count; i++) await insertSpore(e.db, { projectId }, spore(imported(i) ? `spore_${i.toString().padStart(8, '0')}` : crypto.randomUUID(), { sessionId: `history-${i % 45}`, content: i < 10 ? `${name} network evidence collection` : `background ${i}` }));
        for (let i = 0; i < plans; i++) {
          const origin = `/Users/fixture/Repos/${name}/.claude/plans/evidence-${i}.md`;
          const normalized = normalizePlanPath(`/Users/fixture/Repos/${name}`, origin);
          const key = imported(i) ? planKeyForPath(projectId, normalized) : origin;
          planKeys.get(projectId)!.add(key);
          e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at, origin_path)
            VALUES (?, ?, 'history', ?, 'machine_1', ?, 'network evidence collection', ?, 'active', ?, ?, 'fixture', ?, ?)`,
          [projectId, key, `event-${i}`, `${name} network plan evidence collection`, `hash-${i}`, NOW, NOW, NOW, imported(i) ? normalized : origin]);
        }
        const semantic = (await resolveSemanticSearch(e.serverEnv))!;
        for (let i = 0; i < 3000; i++) if ((await reconcileEmbedding({ db: e.db, blobs: e.bucket, ...semantic }, projectId, NOW)).processed === 0) break;
        expect(e.sqlite.query(`SELECT type, COUNT(*) AS n FROM embedding_receipts WHERE project_id = ? AND ready = 1 GROUP BY type ORDER BY type`).all(projectId)).toEqual([{ type: 'plan', n: plans }, { type: 'spore', n: count }]);
        expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_receipts WHERE project_id = ? AND type = 'spore' AND neighbor_mean IS NOT NULL AND neighbor_std IS NOT NULL`).get(projectId)).toEqual({ n: count });
      }
      const semantic = (await resolveSemanticSearch(e.serverEnv))!;
      for (const projectId of ['proj_1', 'proj_2']) {
        namespaces.length = 0;
        const response = await worker.fetch(new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(issued.token, { 'x-myco-project': projectId }), body: JSON.stringify({ sessionId: 'new-session', promptId: 'new-prompt', text: 'collect evidence for the controller' }) }), e.env);
        const answer = await response.json() as { context: string; skipped: string[]; parts: Array<{ kind: string; sporeIds?: string[]; planIds?: string[] }> };
        expect(answer.context).toContain(projectId === 'proj_1' ? 'myco' : 'unifi-mcp');
        if (legacyOnly && projectId === 'proj_2') {
          const part = answer.parts.find((part) => part.kind === 'spores')!;
          expect(part.sporeIds).toHaveLength(3);
          expect(part.sporeIds!.every((id) => id.startsWith('spore_'))).toBe(true);
          expect(part.planIds).toHaveLength(2);
          expect(part.planIds!.every((id) => planKeys.get(projectId)!.has(id))).toBe(true);
        }
        expect(new Set(namespaces)).toEqual(new Set([await vectorNamespace({ projectId, modelKey: semantic.provider.modelKey })]));
        expect({ projectId, skipped: answer.skipped, nonempty: answer.context.length > 0 }).toEqual({ projectId, skipped: ['plan-nudge:no_intent'], nonempty: true });
        const row = e.sqlite.query('SELECT selection, parts FROM prompt_context_answers WHERE project_id = ?').get(projectId) as { selection: string; parts: string };
        const spores = legacyOnly ? 3 : 0;
        const planHits = projectId === 'proj_1' ? 4 : 100;
        const hydratedPlans = 2;
        const sporeHits = projectId === 'proj_1' ? 30 : 100;
        expect(JSON.parse(row.selection)).toEqual({
          sporeRawMatches: projectId === 'proj_1' ? 30 : 100, sporeJoined: projectId === 'proj_1' ? 30 : 100, sporeHits: projectId === 'proj_1' ? 30 : 100,
          sporeCalibrated: sporeHits, sporeScored: sporeHits, sporeProbable: legacyOnly ? 10 : 0, sporeSeparated: legacyOnly ? 10 : 0,
          sporeRelevant: spores, sporeHydrated: spores,
          planRawMatches: planHits, planJoined: planHits, planHits, planUnserved: planHits, planEligible: planHits, planCalibrationFailed: 0, planCalibrated: planHits,
          planScored: planHits, planProbable: planHits, planSeparated: planHits, planRelevant: hydratedPlans, planHydrated: hydratedPlans, budgetKept: spores + hydratedPlans,
        });
        expect(JSON.parse(row.parts)).toEqual([{ kind: 'spores', sporeCount: spores, planCount: hydratedPlans }]);
      }
      expect(e.sqlite.query('SELECT project_id FROM spore_injections ORDER BY project_id').all()).toEqual([{ project_id: 'proj_1' }, { project_id: 'proj_2' }]);
      expect(e.sqlite.query('SELECT project_id, outcome FROM prompt_context_answers ORDER BY project_id').all()).toEqual([{ project_id: 'proj_1', outcome: 'served' }, { project_id: 'proj_2', outcome: 'served' }]);
    } finally { e.sqlite.close(); }
  });

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

  it('answers the explicitly cortex-off Project an empty block naming the gate', async () => {
    const { e, token } = await member();
    await settingsWriter(e.db).setCapability('proj_1', 'cortex', false, 'mem_machine_1', NOW);
    const answer = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }), e.env)).json();
    expect(answer).toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'] });
  });

  it('answers the composed block, its parts, and nothing a second time', async () => {
    const { e, token } = await member();
    admit(e);
    await insertSpore(e.db, { projectId: 'proj_1' }, spore('sp_route', { observationType: 'decision', content: 'the hook answers first' }));
    e.env.AI = { run: async (_model: string, input: { text: string[] }) => ({ data: [input.text[0]!.includes('background') ? [0, 1] : [1, 0]] }) };
    e.env.VECTORIZE = indexFixture();
    for (let i = 0; i < 3; i++) await insertSpore(e.db, { projectId: 'proj_1' }, spore(`background-${i}`));
    const semantic = (await resolveSemanticSearch(e.serverEnv))!;
    for (let i = 0; i < 10; i++) {
      if ((await reconcileEmbedding({ db: e.db, blobs: e.bucket, ...semantic }, 'proj_1', NOW)).processed === 0) break;
    }

    const first = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }), e.env)).json() as Record<string, unknown>;
    expect(first.persisted).toBe(true);
    expect(first.parts).toEqual([{ kind: 'plan-nudge' }, { kind: 'spores', sporeIds: ['sp_route'], planIds: [] }]);
    expect(String(first.context).startsWith(PLAN_INTENT_NUDGE)).toBe(true);
    expect(String(first.context)).toContain('] (decision) the hook answers first');
    expect(String(first.context).length).toBeLessThanOrEqual(PROMPT_CONTEXT_MAX_CHARS);

    const second = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p2', text: `${PLANNING_PROMPT} once more` }), e.env)).json();
    expect(second).toEqual({ persisted: true, context: '', parts: [], skipped: ['spores:empty', 'plan-nudge:repeat'] });
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

describe('POST /context/session', () => {
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
    new Request('https://s/context/session', {
      method: 'POST',
      headers: memberHeaders(token),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const answer = async (e: ReturnType<typeof sqliteEnv>, token: string, body: unknown) =>
    (await (await worker.fetch(post(token, body), e.env)).json()) as Record<string, unknown>;

  it('requires a positive safe-integer compaction identity and deduplicates it on the server', async () => {
    const { e, token } = await member();
    admit(e);
    await settingsWriter(e.db).setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, 'Keep the plan current.', 'mem_machine_1', NOW);
    for (const compaction of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const got = await answer(e, token, { sessionId: 's1', kind: 'compact', compaction });
      expect({ compaction, persisted: got.persisted, code: got.code }).toEqual({ compaction, persisted: false, code: 'parse' });
    }
    for (const compaction of [1, 2]) {
      const got = await answer(e, token, { sessionId: 's1', kind: 'compact', compaction });
      expect(got.kind).toBe(`cortex-compact:${compaction}`);
      expect(got.context).toContain('Keep the plan current.');
      const repeated = await answer(e, token, { sessionId: 's1', kind: 'compact', compaction });
      expect(repeated.context).toBe('');
      expect(repeated.skipped).toContain('repeat');
    }
  });

  it('refuses a body it cannot read, one that names no session, and one naming a kind it does not serve', async () => {
    const { e, token } = await member();
    for (const body of ['not json', '[]', '{}', { sessionId: 's' }, { kind: 'start' }, { sessionId: 's', kind: 'resume' }, { sessionId: 's', kind: 'start', agentType: '' }, { sessionId: 's', kind: 'subagent', agentId: 42 }]) {
      const got = await answer(e, token, body);
      expect({ body: JSON.stringify(body), persisted: got.persisted, code: got.code })
        .toEqual({ body: JSON.stringify(body), persisted: false, code: 'parse' });
    }
  });

  it('previews a block for a member about to have sessions: composed as a session would be served it, recorded for none', async () => {
    const { e, token } = await member();
    admit(e);
    await settingsWriter(e.db).setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, 'Keep the plan current.', 'mem_machine_1', NOW);
    for (let i = 0; i < 2; i++) {
      const start = await answer(e, token, { kind: 'start', preview: true });
      expect({ persisted: start.persisted, context: start.context, kind: start.kind })
        .toEqual({ persisted: true, context: `${projectLine('proj_1')}\n\nKeep the plan current.`, kind: 'cortex' });
      const sub = await answer(e, token, { kind: 'subagent', preview: true });
      expect(String(sub.context)).toContain(SUBAGENT_CORTEX_GUIDANCE);
    }
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM session_injections`).get()).toEqual({ n: 0 });
    // Nor does a preview bind the repository it names: no session start has named it.
    expect((await answer(e, token, { kind: 'start', preview: true, remote: 'https://github.com/acme/previewed.git' })).persisted).toBe(true);
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM project_remotes`).get()).toEqual({ n: 0 });
    // A preview names no session; one that does is refused, and the session's own start is served as ever.
    expect((await answer(e, token, { sessionId: 's1', kind: 'start', preview: true })).code).toBe('parse');
    expect((await answer(e, token, { sessionId: 's1', kind: 'start' })).context).toContain('Keep the plan current.');
  });

  it('serves only identity on start, subagent, compact and preview when cortex is explicitly off', async () => {
    const { e, token } = await member();
    await settingsWriter(e.db).setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, 'Keep the plan current.', 'mem_machine_1', NOW);
    await settingsWriter(e.db).setCapability('proj_1', 'cortex', false, 'mem_machine_1', NOW);
    for (const [body, kind] of [
      [{ sessionId: 's1', kind: 'start' }, 'cortex'],
      [{ sessionId: 's1', kind: 'subagent', agentId: 'a1' }, 'cortex:a1'],
      [{ sessionId: 's1', kind: 'compact', compaction: 1 }, 'cortex-compact:1'],
      [{ kind: 'start', preview: true }, 'cortex'],
      [{ kind: 'subagent', preview: true }, 'cortex:unknown'],
    ] as const) {
      expect(await answer(e, token, body))
        .toEqual({ persisted: true, context: projectLine('proj_1'), parts: [{ kind: 'project' }], skipped: ['capability'], kind });
    }
  });

  it('answers the instructions once, and the subagent block under its own kind', async () => {
    const { e, token } = await member();
    admit(e);
    // The template a member wrote through the Settings surface is what a session start serves.
    await settingsWriter(e.db).setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, '  Keep the plan current.  ', 'mem_machine_1', NOW);

    const first = await answer(e, token, { sessionId: 's1', kind: 'start' });
    expect(first.persisted).toBe(true);
    expect(first.parts).toEqual([{ kind: 'project' }, { kind: 'instructions' }]);
    expect(first.context).toBe(`${projectLine('proj_1')}\n\nKeep the plan current.`);
    expect(first.kind).toBe('cortex');
    expect(String(first.context).length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_CHARS);

    expect(await answer(e, token, { sessionId: 's1', kind: 'start' }))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['repeat'], kind: 'cortex' });

    // Two delegations of one type: the id keys them apart and each is served.
    for (const agentId of ['a1', 'a2']) {
      const delegated = await answer(e, token, { sessionId: 's1', kind: 'subagent', agentId, agentType: 'code-reviewer' });
      expect({ agentId, parts: delegated.parts, kind: delegated.kind })
        .toEqual({ agentId, parts: [{ kind: 'project' }, { kind: 'instructions' }], kind: `cortex:${agentId}` });
      expect(String(delegated.context).startsWith(projectLine('proj_1'))).toBe(true);
      expect(String(delegated.context)).toContain(SUBAGENT_CORTEX_GUIDANCE);
    }

    expect(e.sqlite.query(`SELECT kind FROM session_injections ORDER BY kind`).all())
      .toEqual([{ kind: 'cortex' }, { kind: 'cortex:a1' }, { kind: 'cortex:a2' }]);
  });
});
