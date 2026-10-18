/**
 * What the Deployment records of a prompt's identity: how an ask named its prompt, the rows it wrote and names back,
 * where a delivery says the context reached the agent, and the invariant that every named prompt resolves.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { composePromptContext, type RecallLeaves } from '@myco-server-worker/core/recall.js';
import { danglingPromptReferences, danglingReferenceSql, PROMPT_REFERENCE_KINDS } from '@myco-server-worker/read/prompt-reference-invariant.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { RECEIPT_COLLISIONS_META_KEY } from '@myco-server-worker/db/schema.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { sqliteD1 } from './helpers/d1.js';
import { envelope, memberHeaders, sqliteEnv, uuid } from './helpers/fixtures.js';
import { semanticRecall } from './helpers/semantic-recall.js';

const NOW = Date.now();
const SESSION = 'sess-identity';
const ON: RecallLeaves = { injection: { enabled: true, maxPerPrompt: 3 }, planNudge: false, instructionsAtSessionStart: true, instructionsAtSubagentStart: true, instructionsTemplate: '' };
const PROMPT = 'what did we settle on for the selector';

async function member() {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`);
  e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, 0, 'test')`);
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: issued.tokenId, bodyBytes: 10, now: NOW };
  return { e, token: issued.token, ctx };
}
const ask = (token: string, body: unknown) => new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify(body) });
const rows = (sqlite: Database, sql: string, ...params: unknown[]) => sqlite.query(sql).all(...(params as never[])) as Record<string, unknown>[];

describe('a context ask names its prompt', () => {
  it('records an older member\'s ask as legacy under the id it sent, and a v1 ask under its id or its reason', async () => {
    const { e, token } = await member();
    const legacy = await (await worker.fetch(ask(token, { sessionId: SESSION, promptId: uuid(1), text: PROMPT }), e.env)).json() as Record<string, unknown>;
    const named = await (await worker.fetch(ask(token, { sessionId: SESSION, promptId: uuid(2), identity: 1, at: NOW - 5, text: PROMPT }), e.env)).json() as Record<string, unknown>;
    const unnamed = await (await worker.fetch(ask(token, { sessionId: SESSION, scopeReason: 'absent_key', identity: 1, at: NOW - 3, text: PROMPT }), e.env)).json() as Record<string, unknown>;
    for (const answer of [legacy, named, unnamed]) expect(answer).toMatchObject({ persisted: true, answerId: expect.any(String) });
    expect(rows(e.sqlite, `SELECT id, prompt_id, scope_reason, ask_protocol, asked_at FROM prompt_context_answers ORDER BY created_at, rowid`)).toEqual([
      { id: legacy.answerId, prompt_id: uuid(1), scope_reason: null, ask_protocol: 'legacy', asked_at: null },
      { id: named.answerId, prompt_id: uuid(2), scope_reason: null, ask_protocol: 'v1', asked_at: NOW - 5 },
      { id: unnamed.answerId, prompt_id: null, scope_reason: 'absent_key', ask_protocol: 'v1', asked_at: NOW - 3 },
    ]);
  });

  it('refuses a v1 ask that names both a prompt and a reason, neither, no instant, or a reason it does not record', async () => {
    const { e, token } = await member();
    for (const body of [
      { sessionId: SESSION, promptId: uuid(1), scopeReason: 'absent_key', identity: 1, at: NOW, text: PROMPT },
      { sessionId: SESSION, identity: 1, at: NOW, text: PROMPT },
      { sessionId: SESSION, promptId: uuid(1), identity: 1, text: PROMPT },
      { sessionId: SESSION, scopeReason: 'legacy_member', identity: 1, at: NOW, text: PROMPT },
      { sessionId: SESSION, promptId: uuid(1), identity: 2, at: NOW, text: PROMPT },
    ]) {
      const answer = await (await worker.fetch(ask(token, body), e.env)).json() as Record<string, unknown>;
      expect({ body, code: answer.code }).toEqual({ body, code: 'parse' });
    }
    expect(rows(e.sqlite, `SELECT 1 FROM prompt_context_answers`)).toEqual([]);
  });

  it('writes nothing naming a session another machine holds', async () => {
    const { e, token } = await member();
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_2', 'other', 1, 1)`, [SESSION]);
    const answer = await (await worker.fetch(ask(token, { sessionId: SESSION, promptId: uuid(1), identity: 1, at: NOW, text: PROMPT }), e.env)).json() as Record<string, unknown>;
    expect(answer).toMatchObject({ persisted: false, code: 'identity_mismatch' });
    expect(rows(e.sqlite, `SELECT 1 FROM prompt_context_answers`)).toEqual([]);
  });
});

describe('the rows an answer names', () => {
  it('names the receipt it wrote and the answer it wrote, and no receipt when the selection wrote none', async () => {
    const { e } = await member();
    const db = e.db;
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, importance, created_at, embedded) VALUES ('proj_1', ?, 'agent_1', 'decision', 'active', ?, 5, 1, 0)`, [id, `selector fact ${id}`]);
    const compose = (promptId: string, text: string) => composePromptContext(db, { projectId: 'proj_1' }, ON, true,
      { sessionId: SESSION, text, now: NOW, promptId, scopeReason: null, askProtocol: 'v1', askedAt: NOW }, semanticRecall(db, { projectId: 'proj_1' }));
    const first = await compose(uuid(1), PROMPT);
    expect(rows(e.sqlite, `SELECT id, prompt_id FROM spore_injections`)).toEqual([{ id: first.receiptId, prompt_id: uuid(1) }]);
    expect(rows(e.sqlite, `SELECT id FROM prompt_context_answers`)).toEqual([{ id: first.answerId }]);
    // More spores than one prompt takes, so a later ask still selects some and reaches the receipt's rules.
    const repeat = await compose(uuid(2), PROMPT);
    expect({ receipt: repeat.receiptId, repeat: repeat.skipped.includes('spores:repeat') }).toEqual({ receipt: undefined, repeat: true });
    const reused = await compose(uuid(1), `${PROMPT} again`);
    expect({ receipt: reused.receiptId, duplicate: reused.skipped.includes('spores:duplicate_prompt') }).toEqual({ receipt: undefined, duplicate: true });
    expect(rows(e.sqlite, `SELECT COUNT(*) AS n FROM prompt_context_answers`)).toEqual([{ n: 3 }]);
  });
});

describe('a delivery', () => {
  async function delivering() {
    const m = await member();
    m.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, m.ctx.tokenId]);
    m.e.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, id, prompt_id, ask_protocol, asked_at, prompt_hash, spore_ids, created_at) VALUES ('proj_1', ?, ?, ?, 'v1', 1, 'h', '[]', 1)`, [SESSION, uuid(10), uuid(1)]);
    m.e.sqlite.run(`INSERT INTO prompt_context_answers (project_id, session_id, id, prompt_id, ask_protocol, outcome, context_chars, parts, skipped, failures, selection, created_at) VALUES ('proj_1', ?, ?, ?, 'v1', 'served', 1, '[]', '[]', '[]', '{}', 1)`, [SESSION, uuid(11), uuid(1)]);
    const deliver = (n: number, payload: Record<string, unknown>, at = NOW - 10, sessionId = SESSION) =>
      ingestEvent(m.e.db, m.ctx, envelope({ eventId: uuid(100 + n), sessionId, kind: 'context.delivered', createdAt: at, payload }));
    const delivery = (table: string) => rows(m.e.sqlite, `SELECT delivered_at, delivered_prompt_id, delivered_scope_reason FROM ${table}`)[0];
    return { ...m, deliver, delivery };
  }

  it('marks the rows it names delivered to the prompt that carried them, at its own instant, once', async () => {
    const d = await delivering();
    expect(await d.deliver(1, { receiptId: uuid(10), answerId: uuid(11), renderedIn: uuid(2) })).toMatchObject({ persisted: true });
    expect(d.delivery('spore_injections')).toEqual({ delivered_at: NOW - 10, delivered_prompt_id: uuid(2), delivered_scope_reason: null });
    expect(d.delivery('prompt_context_answers')).toEqual({ delivered_at: NOW - 10, delivered_prompt_id: uuid(2), delivered_scope_reason: null });
    await d.deliver(2, { receiptId: uuid(10), renderedScopeReason: 'absent_key' }, NOW - 5);
    expect(d.delivery('spore_injections')).toEqual({ delivered_at: NOW - 10, delivered_prompt_id: uuid(2), delivered_scope_reason: null });
  });

  it('records a delivery to a prompt with no name as such, distinct from no delivery', async () => {
    const d = await delivering();
    await d.deliver(1, { answerId: uuid(11), renderedScopeReason: 'absent_key' });
    expect(d.delivery('prompt_context_answers')).toEqual({ delivered_at: NOW - 10, delivered_prompt_id: null, delivered_scope_reason: 'absent_key' });
    expect(d.delivery('spore_injections')).toEqual({ delivered_at: null, delivered_prompt_id: null, delivered_scope_reason: null });
  });

  it('names rows only in its own session, and is refused naming no row or both a prompt and a reason', async () => {
    const d = await delivering();
    await d.deliver(1, { receiptId: uuid(10), renderedIn: uuid(2) }, NOW - 10, 'another-session');
    expect(d.delivery('spore_injections')).toEqual({ delivered_at: null, delivered_prompt_id: null, delivered_scope_reason: null });
    expect(await d.deliver(2, { renderedIn: uuid(2) })).toMatchObject({ persisted: false, code: 'invalid_field' });
    expect(await d.deliver(3, { receiptId: uuid(10), renderedIn: uuid(2), renderedScopeReason: 'absent_key' })).toMatchObject({ persisted: false, code: 'invalid_field' });
  });
});

describe('the prompt-reference invariant', () => {
  async function seeded() {
    const { e } = await member();
    const transcript = (session: string, opts: { through: number; caughtUp?: boolean }) => e.sqlite.run(`INSERT INTO transcripts
      (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, segment_count, first_received_at, last_received_at, token_id, role, parsed_through_at)
      VALUES ('proj_1', ?, ?, 'machine_1', 'claude-code', 100, ?, 1, 1, 1, 't', 'primary', ?)`, [`tx_${session}`, session, opts.caughtUp === false ? 50 : 100, opts.through]);
    const receipt = (session: string, n: number, over: Record<string, unknown> = {}) => {
      const row = { project_id: 'proj_1', session_id: session, id: uuid(n), prompt_id: uuid(n), scope_reason: null, ask_protocol: 'v1', asked_at: 100, prompt_hash: `h${n}`, spore_ids: '[]', created_at: NOW, ...over };
      e.sqlite.run(`INSERT INTO spore_injections (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row) as never[]);
    };
    return { e, transcript, receipt };
  }

  it('counts a named prompt the session does not hold once its transcript was read past the ask', async () => {
    const s = await seeded();
    s.transcript('read', { through: 200 });
    s.receipt('read', 1);
    s.receipt('read', 2, { delivered_at: 150, delivered_prompt_id: uuid(99) });
    expect(await danglingPromptReferences(s.e.db, 0)).toEqual({ receipt_selected: 2, answer_selected: 0, receipt_delivered: 1, answer_delivered: 0 });
    s.e.sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, content_hash, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', ?, 'read', 'e1', 'user', 'h', 1, 1, 't', 1), ('proj_1', ?, 'read', 'e2', 'user', 'h', 1, 1, 't', 1)`, [uuid(1), uuid(99)]);
    expect(await danglingPromptReferences(s.e.db, 0)).toEqual({ receipt_selected: 1, answer_selected: 0, receipt_delivered: 0, answer_delivered: 0 });
  });

  it('counts nothing in flight, legacy, session-scoped, deleted, or before the bound', async () => {
    const s = await seeded();
    s.transcript('early', { through: 50 });
    s.receipt('early', 1);
    s.transcript('behind', { through: 200, caughtUp: false });
    s.receipt('behind', 2);
    s.transcript('legacy', { through: 200 });
    s.receipt('legacy', 3, { ask_protocol: 'legacy' });
    s.receipt('legacy', 4, { prompt_id: null, scope_reason: 'absent_key' });
    s.transcript('gone', { through: 200 });
    s.receipt('gone', 5);
    s.e.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES ('proj_1', 'gone', 1, 'm')`);
    s.transcript('old', { through: 200 });
    s.receipt('old', 6, { created_at: 1 });
    expect(await danglingPromptReferences(s.e.db, 2)).toEqual({ receipt_selected: 0, answer_selected: 0, receipt_delivered: 0, answer_delivered: 0 });
  });

  it('is one statement per kind of reference, each served by an index rather than a scan of a reference table', () => {
    const sqlite = new Database(':memory:');
    for (const step of SCHEMA_STEPS) for (const statement of step.statements) sqlite.run(statement);
    for (const kind of PROMPT_REFERENCE_KINDS) {
      const plan = (sqlite.query(`EXPLAIN QUERY PLAN ${danglingReferenceSql(kind)}`).all(0) as { detail: string }[]).map((r) => r.detail).join('\n');
      expect({ kind, scans: plan.split('\n').filter((d) => /^SCAN (p|t|x)\b/.test(d)) }).toEqual({ kind, scans: [] });
    }
  });
});

describe('deleting a session', () => {
  it('removes what was served to it, and leaves its spores naming no prompt of it', async () => {
    const { e, ctx } = await member();
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, ctx.tokenId]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', ?, ?, 'e1', 'user', 'h', 1, 1, 't', 1)`, [uuid(1), SESSION]);
    e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, prompt_id, observation_type, status, content, importance, created_at, embedded) VALUES ('proj_1', 'kept', 'agent_1', ?, ?, 'decision', 'active', 'c', 5, 1, 0)`, [SESSION, uuid(1)]);
    e.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, created_at) VALUES ('proj_1', ?, ?, 'h', '[]', 1)`, [SESSION, uuid(1)]);
    e.sqlite.run(`INSERT INTO prompt_context_answers (project_id, session_id, id, prompt_id, outcome, context_chars, parts, skipped, failures, selection, created_at) VALUES ('proj_1', ?, 'a', ?, 'empty', 0, '[]', '[]', '[]', '{}', 1)`, [SESSION, uuid(1)]);
    e.sqlite.run(`INSERT INTO session_injections (project_id, session_id, kind, created_at) VALUES ('proj_1', ?, 'cortex', 1)`, [SESSION]);
    await tombstoneSession(e.serverEnv, { projectId: 'proj_1' }, SESSION, 'mem_machine_1', NOW);
    for (const table of ['spore_injections', 'prompt_context_answers', 'session_injections']) expect({ table, rows: rows(e.sqlite, `SELECT 1 FROM ${table}`).length }).toEqual({ table, rows: 0 });
    expect(rows(e.sqlite, `SELECT id, prompt_id FROM spores`)).toEqual([{ id: 'kept', prompt_id: null }]);
  });
});

describe('schema step 89', () => {
  it('keeps every receipt and answer as legacy under its prompt id, gives each receipt an id, and counts receipts it could not keep', async () => {
    const sqlite = new Database(':memory:');
    const db = sqliteD1(sqlite);
    await applySchemaSteps(db, SCHEMA_STEPS.filter((s) => s.version <= 88));
    sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 0)`);
    sqlite.run(`INSERT INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, created_at)
      VALUES ('proj_1', 's', 'p1', 'h1', '["a"]', 1), ('proj_1', 's', 'p1', 'h2', '["b"]', 2), ('proj_1', 's', 'p2', 'h3', '[]', 3)`);
    sqlite.run(`INSERT INTO prompt_context_answers (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
      VALUES ('proj_1', 's', 'p1', 'a1', 'served', 1, '[]', '[]', '[]', '{}', 1), ('proj_1', 's', 'p1', 'a2', 'empty', 0, '[]', '[]', '[]', '{}', 2)`);
    await applySchemaSteps(db, SCHEMA_STEPS.filter((s) => s.version === 89));
    const receipts = rows(sqlite, `SELECT id, prompt_id, prompt_hash, spore_ids, ask_protocol, scope_reason FROM spore_injections ORDER BY created_at`);
    expect(receipts.map(({ id: _id, ...r }) => r)).toEqual([
      { prompt_id: 'p1', prompt_hash: 'h1', spore_ids: '["a"]', ask_protocol: 'legacy', scope_reason: null },
      { prompt_id: 'p2', prompt_hash: 'h3', spore_ids: '[]', ask_protocol: 'legacy', scope_reason: null },
    ]);
    for (const r of receipts) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows(sqlite, `SELECT value FROM schema_meta WHERE key = ?`, RECEIPT_COLLISIONS_META_KEY)).toEqual([{ value: '1' }]);
    expect(rows(sqlite, `SELECT id, prompt_id, ask_protocol FROM prompt_context_answers ORDER BY created_at`)).toEqual([
      { id: 'a1', prompt_id: 'p1', ask_protocol: 'legacy' }, { id: 'a2', prompt_id: 'p1', ask_protocol: 'legacy' },
    ]);
  });

  it('holds one encoding of a prompt that has no name: no prompt id exactly when a reason, on both tables', async () => {
    const sqlite = new Database(':memory:');
    await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS);
    sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 0)`);
    const receipt = (n: number, promptId: string | null, reason: string | null) => sqlite.run(`INSERT INTO spore_injections (project_id, session_id, prompt_id, scope_reason, prompt_hash, spore_ids, created_at)
      VALUES ('proj_1', 's', ?, ?, ?, '[]', 1)`, [promptId, reason, `h${n}`]);
    const answer = (n: number, promptId: string | null, reason: string | null) => sqlite.run(`INSERT INTO prompt_context_answers (project_id, session_id, id, prompt_id, scope_reason, outcome, context_chars, parts, skipped, failures, selection, created_at)
      VALUES ('proj_1', 's', ?, ?, ?, 'empty', 0, '[]', '[]', '[]', '{}', 1)`, [`a${n}`, promptId, reason]);
    for (const write of [receipt, answer]) {
      expect(() => write(1, null, null)).toThrow(/CHECK constraint failed/);
      expect(() => write(2, 'p', 'absent_key')).toThrow(/CHECK constraint failed/);
      write(3, null, 'absent_key');
      write(4, null, 'absent_key');
      write(5, 'p', null);
    }
    expect(() => receipt(6, 'p', null)).toThrow(/UNIQUE constraint failed/);
    answer(6, 'p', null);
  });
});
