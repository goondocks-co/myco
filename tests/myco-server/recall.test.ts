/**
 * Recall: the capability gate over everything, the contributors and the order
 * they stand in, the once-per-session records, the bounds at a part boundary,
 * and the two routes that serve them.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import {
  composePromptContext, composeSessionContext, detectsPlanIntent, digestHeading, partsWithinBound,
  PLAN_INTENT_NUDGE, PROMPT_CONTEXT_MAX_CHARS, recallLeaves, recordSessionInjection,
  SESSION_CONTEXT_MAX_CHARS, sessionInjectionKind, SUBAGENT_CORTEX_GUIDANCE,
  type RecallLeaves, type RecallSkip, type SessionContextKind,
} from '@myco-server-worker/core/recall.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore, type SporeInsert } from '@myco-server-worker/core/spores.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { semanticRecall } from './helpers/semantic-recall.js';
import { indexFixture } from './helpers/vector-index.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const SESSION = 'sess_1';
/** Plain enough to carry no planning intent, long enough to clear the selector's floor. */
const PROMPT = 'what did we settle on for the selector';
const PLANNING_PROMPT = 'let us write the implementation plan for the selector';

const ON: RecallLeaves = {
  injection: { enabled: true, maxPerPrompt: 3 },
  planNudge: true,
  instructionsAtSessionStart: true,
  instructionsAtSubagentStart: true,
  digestAtSessionStart: false,
  digestTier: 5000,
};

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
}, semanticRecall(db, over.scope ?? SCOPE));

const sessionRows = (sqlite: Database) =>
  sqlite.query(`SELECT project_id, session_id, kind, created_at FROM session_injections`).all() as Record<string, string | number>[];

describe('the recall leaves', () => {
  it('defaults the nudge on and carries the injection leaves through', () => {
    expect(recallLeaves({})).toEqual(ON);
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': false }).planNudge).toBe(false);
    expect(recallLeaves({ 'cortex.plans.inject_intent_nudge_on_prompt_submit': 'yes' }).planNudge).toBe(true);
    expect(recallLeaves({ 'cortex.spores.max_per_prompt': 1 }).injection.maxPerPrompt).toBe(1);
  });

  it('starts a session with instructions and without the digest, at the middle tier', () => {
    expect(recallLeaves({})).toMatchObject({
      instructionsAtSessionStart: true, instructionsAtSubagentStart: true, digestAtSessionStart: false, digestTier: 5000,
    });
    expect(recallLeaves({ 'cortex.digest.inject_on_session_start': true }).digestAtSessionStart).toBe(true);
    expect(recallLeaves({ 'cortex.instructions.inject_on_session_start': false }).instructionsAtSessionStart).toBe(false);
    expect(recallLeaves({ 'cortex.instructions.inject_on_subagent_start': false }).instructionsAtSubagentStart).toBe(false);
  });

  it('takes only a digest size the Settings page offers', () => {
    for (const tier of [1500, 5000, 10000]) {
      expect(recallLeaves({ 'cortex.digest.tier': tier }).digestTier).toBe(tier);
    }
    // Anything else falls to the default rather than asking the store for a tier nobody generates.
    for (const tier of [0, 42, 20000, '5000', null]) {
      expect({ tier, served: recallLeaves({ 'cortex.digest.tier': tier }).digestTier }).toEqual({ tier, served: 5000 });
    }
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
    expect(repeat).toEqual({ context: '', parts: [], skipped: ['spores:empty', 'plan-nudge:no_intent'] });
  });

  it('names the record\'s own gate when the pool still holds a spore the prompt content already spent', async () => {
    const { db } = store();
    const one: RecallLeaves = { injection: { enabled: true, maxPerPrompt: 1 }, planNudge: true };
    await insertSpore(db, SCOPE, spore('a', { createdAt: NOW - 1 }));
    await insertSpore(db, SCOPE, spore('b', { createdAt: NOW - 2 }));
    expect((await compose(db, { leaves: one, promptId: 'p1' })).parts).toEqual([{ kind: 'spores', sporeIds: ['a'] }]);
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


// ---------------------------------------------------------------------------
// Session start and subagent start
// ---------------------------------------------------------------------------

const instructions = (sqlite: Database, over: Partial<{ id: string; agentId: string; content: string; generatedAt: number; projectId: string }> = {}) =>
  sqlite.query(`INSERT INTO cortex_instructions (project_id, id, agent_id, content, input_hash, source_run_id, generated_at) VALUES (?, ?, ?, ?, 'h', NULL, ?)`)
    .run(over.projectId ?? SCOPE.projectId, over.id ?? 'ci_1', over.agentId ?? AGENT, over.content ?? '  # Project guidance\nKeep the plan current.  ', over.generatedAt ?? NOW);

const forSession = (
  db: RelationalStore,
  over: Partial<{ leaves: RecallLeaves; capabilityOn: boolean; scope: ReadScope; sessionId: string; kind: SessionContextKind; agentId: string; agentType: string; now: number }> = {},
) => composeSessionContext(db, over.scope ?? SCOPE, over.leaves ?? ON, over.capabilityOn ?? true, {
  sessionId: over.sessionId ?? SESSION,
  kind: over.kind ?? 'start',
  agentId: over.agentId,
  agentType: over.agentType,
  now: over.now ?? NOW,
});

/** An empty block for a start, with the gates it closed on. */
const emptyStart = (skipped: RecallSkip[]) => ({ context: '', parts: [], skipped, kind: 'cortex' });

describe('the newest instructions', () => {
  it('serves the latest generation, and the lower id where two agents landed in the same instant', async () => {
    const { db, sqlite } = store();
    instructions(sqlite, { id: 'ci_old', agentId: 'agent_old', content: 'the old guidance', generatedAt: NOW - 1000 });
    instructions(sqlite, { id: 'ci_new', agentId: 'agent_new', content: 'the current guidance', generatedAt: NOW });
    expect((await forSession(db)).context).toBe('the current guidance');

    const tied = store();
    instructions(tied.sqlite, { id: 'ci_b', agentId: 'agent_b', content: 'the b guidance', generatedAt: NOW });
    instructions(tied.sqlite, { id: 'ci_a', agentId: 'agent_a', content: 'the a guidance', generatedAt: NOW });
    expect((await forSession(tied.db)).context).toBe('the a guidance');
  });

  it('answers an empty block for a Project holding no instructions, and records nothing', async () => {
    const { db, sqlite } = store();
    expect(await forSession(db)).toEqual(emptyStart(['instructions:empty', 'digest:off']));
    expect(sessionRows(sqlite)).toEqual([]);
  });
});

describe('a session start', () => {
  it('serves the trimmed instructions with no heading of their own', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    const served = await forSession(db);
    expect(served.context).toBe('# Project guidance\nKeep the plan current.');
    expect(served.parts).toEqual([{ kind: 'instructions' }]);
    expect(served.skipped).toEqual(['digest:off']);
    expect(served.kind).toBe('cortex');
    expect(sessionRows(sqlite)).toEqual([{ project_id: SCOPE.projectId, session_id: SESSION, kind: 'cortex', created_at: NOW }]);
  });

  it('serves nothing a second time and names the record standing', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    expect((await forSession(db)).parts).toEqual([{ kind: 'instructions' }]);
    expect(await forSession(db)).toEqual(emptyStart(['digest:off', 'repeat']));
    expect(sessionRows(sqlite)).toHaveLength(1);
  });

  it('holds the instructions back where the Deployment switched them off', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    expect(await forSession(db, { leaves: { ...ON, instructionsAtSessionStart: false } }))
      .toEqual(emptyStart(['instructions:off', 'digest:off']));
    expect(sessionRows(sqlite)).toEqual([]);
  });

  it('is served nothing at all where the Project is not admitted', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    expect(await forSession(db, { capabilityOn: false })).toEqual(emptyStart(['capability']));
    expect(sessionRows(sqlite)).toEqual([]);
  });
});

describe('the digest at session start', () => {
  const digest = (db: RelationalStore, tier: number, content: string, generatedAt = NOW, scope: ReadScope = SCOPE) =>
    upsertDigest(db, scope, { id: `dg_${tier}`, agentId: AGENT, tier, content, substrateHash: null, generatedAt });

  it('stays away unless the Deployment asks for it', async () => {
    const { db } = store();
    await digest(db, 5000, 'the middle digest');
    expect(await forSession(db)).toEqual(emptyStart(['instructions:empty', 'digest:off']));
  });

  it('names the empty where the Deployment asks for a digest the Project has never generated', async () => {
    const { db } = store();
    expect((await forSession(db, { leaves: { ...ON, digestAtSessionStart: true } })).skipped)
      .toEqual(['instructions:empty', 'digest:empty']);
  });

  it('stands under its tier heading, after the instructions', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    await digest(db, 5000, 'the middle digest');
    const served = await forSession(db, { leaves: { ...ON, digestAtSessionStart: true } });
    expect(served.context).toBe(`# Project guidance\nKeep the plan current.\n\n## Preferred Digest (Tier 5000)\nthe middle digest`);
    expect(served.parts).toEqual([{ kind: 'instructions' }, { kind: 'digest', tier: 5000 }]);
  });

  it('falls to the nearest tier the Project holds, and the heading names the tier served', async () => {
    const { db } = store();
    await digest(db, 10000, 'the long digest');
    const served = await forSession(db, { leaves: { ...ON, digestAtSessionStart: true } });
    expect(served.parts).toEqual([{ kind: 'digest', tier: 10000 }]);
    expect(served.context).toBe(`${digestHeading(10000)}the long digest`);
  });

  it('takes the exact tier where the Project holds it', async () => {
    const { db } = store();
    await digest(db, 1500, 'the short digest');
    await digest(db, 5000, 'the middle digest');
    const served = await forSession(db, { leaves: { ...ON, digestAtSessionStart: true, digestTier: 1500 } });
    expect(served.parts).toEqual([{ kind: 'digest', tier: 1500 }]);
    expect(served.context.startsWith(digestHeading(1500))).toBe(true);
  });

  it('names the contributor that failed and serves the rest', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    sqlite.exec('DROP TABLE digest_extracts');
    const served = await forSession(db, { leaves: { ...ON, digestAtSessionStart: true } });
    expect(served.skipped).toEqual(['digest']);
    expect(served.parts).toEqual([{ kind: 'instructions' }]);
  });
});

describe('a subagent start', () => {
  it('hands the delegated agent the guidance lines above the instructions', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    const served = await forSession(db, { kind: 'subagent', agentType: 'code-reviewer' });
    expect(served.context).toBe(`${SUBAGENT_CORTEX_GUIDANCE}\n\n# Project guidance\nKeep the plan current.`);
    expect(served.context.split('\n').slice(0, 3)).toEqual([
      'You are a delegated subagent working inside a Myco-connected project.',
      'Follow these managed Cortex instructions as current project guidance.',
      'Apply them to your assigned task, and defer broad orchestration decisions back to the parent agent.',
    ]);
    expect(served.parts).toEqual([{ kind: 'instructions' }]);
  });

  it('is never served the digest', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    await upsertDigest(db, SCOPE, { id: 'dg', agentId: AGENT, tier: 5000, content: 'the middle digest', substrateHash: null, generatedAt: NOW });
    const served = await forSession(db, { kind: 'subagent', agentType: 'code-reviewer', leaves: { ...ON, digestAtSessionStart: true } });
    expect(served.parts).toEqual([{ kind: 'instructions' }]);
  });

  it('serves every delegation, keyed on its own id, and the session start beside them', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    // Two delegations of one type are two subagents, and each is served.
    for (const agentId of ['a1', 'a2']) {
      const served = await forSession(db, { kind: 'subagent', agentId, agentType: 'code-reviewer' });
      expect({ agentId, parts: served.parts, kind: served.kind })
        .toEqual({ agentId, parts: [{ kind: 'instructions' }], kind: `cortex:${agentId}` });
    }
    // The same delegation twice is one subagent.
    expect(await forSession(db, { kind: 'subagent', agentId: 'a1', agentType: 'code-reviewer' }))
      .toEqual({ context: '', parts: [], skipped: ['repeat'], kind: 'cortex:a1' });
    // A harness naming no id falls to the type, and one naming neither to a single name.
    expect((await forSession(db, { kind: 'subagent', agentType: 'explorer' })).kind).toBe('cortex:explorer');
    expect((await forSession(db, { kind: 'subagent' })).kind).toBe('cortex:unknown');
    expect((await forSession(db, { kind: 'start' })).parts).toEqual([{ kind: 'instructions' }]);
    expect(sessionRows(sqlite).map((r) => r.kind))
      .toEqual(['cortex:a1', 'cortex:a2', 'cortex:explorer', 'cortex:unknown', 'cortex']);
  });

  it('names the delegation the way the record does, trimming what the harness sent', () => {
    expect(sessionInjectionKind('start', 'a1', 'code-reviewer')).toBe('cortex');
    expect(sessionInjectionKind('subagent', ' a1 ', 'code-reviewer')).toBe('cortex:a1');
    expect(sessionInjectionKind('subagent', '  ', ' code-reviewer ')).toBe('cortex:code-reviewer');
    expect(sessionInjectionKind('subagent')).toBe('cortex:unknown');
  });

  it('holds the instructions back where the Deployment switched the subagent surface off', async () => {
    const { db, sqlite } = store();
    instructions(sqlite);
    expect(await forSession(db, { kind: 'subagent', agentType: 'code-reviewer', leaves: { ...ON, instructionsAtSubagentStart: false } }))
      .toEqual({ context: '', parts: [], skipped: ['instructions:off'], kind: 'cortex:code-reviewer' });
    // The session-start surface is a different switch and stays on.
    expect((await forSession(db, { leaves: { ...ON, instructionsAtSubagentStart: false } })).parts).toEqual([{ kind: 'instructions' }]);
  });
});

describe('the session bound', () => {
  it('drops a whole part rather than cutting one mid-line, and burns no record for a block it cannot serve', async () => {
    const { db, sqlite } = store();
    instructions(sqlite, { content: 'x'.repeat(SESSION_CONTEXT_MAX_CHARS) });
    await upsertDigest(db, SCOPE, { id: 'dg', agentId: AGENT, tier: 5000, content: 'the middle digest', substrateHash: null, generatedAt: NOW });
    const served = await forSession(db, { leaves: { ...ON, digestAtSessionStart: true } });
    // The instructions fill the bound exactly; the digest that would cross it is dropped whole.
    expect(served.parts).toEqual([{ kind: 'instructions' }]);
    expect(served.context.length).toBe(SESSION_CONTEXT_MAX_CHARS);

    const tooLong = store();
    instructions(tooLong.sqlite, { content: 'x'.repeat(SESSION_CONTEXT_MAX_CHARS + 1) });
    expect(await forSession(tooLong.db)).toEqual(emptyStart(['digest:off']));
    expect(sessionRows(tooLong.sqlite)).toEqual([]);
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
    e.env.AI = { run: async (_model, input) => ({ data: [input.text[0].includes('background') ? [0, 1] : [1, 0]] }) };
    e.env.VECTORIZE = indexFixture();
    for (let i = 0; i < 3; i++) await insertSpore(e.db, { projectId: 'proj_1' }, spore(`background-${i}`));
    const semantic = (await resolveSemanticSearch(e.serverEnv))!;
    for (let i = 0; i < 10; i++) {
      if ((await reconcileEmbedding({ db: e.db, blobs: e.bucket, ...semantic }, 'proj_1', NOW)).processed === 0) break;
    }

    const first = await (await worker.fetch(post(token, { sessionId: 's1', promptId: 'p1', text: PLANNING_PROMPT }), e.env)).json() as Record<string, unknown>;
    expect(first.persisted).toBe(true);
    expect(first.parts).toEqual([{ kind: 'plan-nudge' }, { kind: 'spores', sporeIds: ['sp_route'] }]);
    expect(String(first.context).startsWith(PLAN_INTENT_NUDGE)).toBe(true);
    expect(String(first.context)).toContain('- (decision) the hook answers first');
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

  it('refuses a body it cannot read, one that names no session, and one naming a kind it does not serve', async () => {
    const { e, token } = await member();
    for (const body of ['not json', '[]', '{}', { sessionId: 's' }, { kind: 'start' }, { sessionId: 's', kind: 'resume' }, { sessionId: 's', kind: 'start', agentType: '' }, { sessionId: 's', kind: 'subagent', agentId: 42 }]) {
      const got = await answer(e, token, body);
      expect({ body: JSON.stringify(body), persisted: got.persisted, code: got.code })
        .toEqual({ body: JSON.stringify(body), persisted: false, code: 'parse' });
    }
  });

  it('answers the Project that is not admitted an empty block naming the gate', async () => {
    const { e, token } = await member();
    expect(await answer(e, token, { sessionId: 's1', kind: 'start' }))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'], kind: 'cortex' });
  });

  it('answers the instructions once, and the subagent block under its own kind', async () => {
    const { e, token } = await member();
    admit(e);
    e.sqlite.query(`INSERT INTO cortex_instructions (project_id, id, agent_id, content, input_hash, source_run_id, generated_at) VALUES ('proj_1', 'ci_1', ?, '  Keep the plan current.  ', 'h', NULL, ?)`).run(AGENT, NOW);

    const first = await answer(e, token, { sessionId: 's1', kind: 'start' });
    expect(first.persisted).toBe(true);
    expect(first.parts).toEqual([{ kind: 'instructions' }]);
    expect(first.context).toBe('Keep the plan current.');
    expect(first.kind).toBe('cortex');
    expect(String(first.context).length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_CHARS);

    expect(await answer(e, token, { sessionId: 's1', kind: 'start' }))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['digest:off', 'repeat'], kind: 'cortex' });

    // Two delegations of one type: the id keys them apart and each is served.
    for (const agentId of ['a1', 'a2']) {
      const delegated = await answer(e, token, { sessionId: 's1', kind: 'subagent', agentId, agentType: 'code-reviewer' });
      expect({ agentId, parts: delegated.parts, kind: delegated.kind })
        .toEqual({ agentId, parts: [{ kind: 'instructions' }], kind: `cortex:${agentId}` });
      expect(String(delegated.context).startsWith(SUBAGENT_CORTEX_GUIDANCE)).toBe(true);
    }

    expect(e.sqlite.query(`SELECT kind FROM session_injections ORDER BY kind`).all())
      .toEqual([{ kind: 'cortex' }, { kind: 'cortex:a1' }, { kind: 'cortex:a2' }]);
  });
});
