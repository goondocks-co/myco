/**
 * Deleting a session, on both sides.
 *
 * Reads and writes are separate halves and a suppression with only one of them
 * is not a deletion. Four reads issue their own SELECT against `sessions`
 * rather than going through the list seam, so each is asserted here BY NAME
 * rather than trusted to inherit the rule. And capture keeps running on the
 * machine after a person presses delete, so the write half is asserted over
 * EVERY kind in the catalogue — a check that lives in a handler would pass a
 * spot test and let the next kind through.
 */
import { registerBlob } from './helpers/d1.js';
import { acquireRecoveryHold, drainObjectReleases, releaseRecoveryHold, RELEASE_PAGE } from '@myco-server-worker/core/object-release.js';
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { isTombstoned, tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { freeOrphanedBlobs } from '@myco-server-worker/ingest/retention.js';
import {
  writeTitle, overwriteTitle, getSession, listSessions, listSessionSummaries, projectHoldsSession, projectStats,
  sessionCounts, sessionHeldByMachine, sessionInScope,
} from '@myco-server-worker/read/sessions.js';
import { activityFeed } from '@myco-server-worker/read/activity.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { listProjectPlans } from '@myco-server-worker/read/plans.js';
import { count, envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';

const NOW = 1_000_000;
const SCOPE = { projectId: 'proj_1' };
const SESSION = 's1';
const MACHINE = 'machine_1';

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  const env = { db: serverEnv.db, blobs: serverEnv.blobs };
  const ctx = { projectId: SCOPE.projectId, machineId: MACHINE, tokenId: issued.tokenId, bodyBytes: 10, now: NOW };
  const send = (over: Record<string, unknown>) => ingestEvent(env.db, ctx, envelope({ sessionId: SESSION, ...over }));
  return { sqlite, env, ctx, send };
}

/** A session carrying one of each row a deletion has to reach. */
async function populate(send: (o: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  await send({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: NOW - 5 } });
  await send({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hello', origin: 'user' } });
  await send({ eventId: uuid(3), kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'hi' } });
  await send({ eventId: uuid(4), kind: 'tool.use', payload: { toolCallId: uuid(40), toolName: 'Read', input: { p: 1 }, success: true } });
  await send({ eventId: uuid(5), kind: 'plan', payload: { planKey: uuid(50), content: '# p', status: 'active', tags: ['plan'] } });
}

describe('tombstoning a session', () => {
  it('records the tombstone and removes every derived row', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    expect(count(sqlite, 'prompt_batches')).toBe(1);

    const outcome = await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW, 'asked');
    expect(outcome.applied).toBe(true);
    expect(outcome.removed).toBeGreaterThan(0);

    for (const table of ['prompt_batches', 'responses', 'tool_calls', 'plans', 'events']) {
      expect({ table, rows: count(sqlite, table) }).toEqual({ table, rows: 0 });
    }
    expect(count(sqlite, 'session_tombstones')).toBe(1);
  });

  it('keeps the sessions row, which is what tells a deleted session from one that never arrived', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect(count(sqlite, 'sessions')).toBe(1);
    expect(await isTombstoned(env.db, SCOPE.projectId, SESSION)).toBe(true);
  });

  it('removes title search and embedding eligibility and refuses a late title write', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    expect(await writeTitle(env.db, SCOPE.projectId, SESSION, 'retentioncanary', 'retentioncanary summary')).toBe(true);
    expect((await searchProject(env.db, SCOPE, { query: 'retentioncanary', mode: 'fts' })).results).toHaveLength(1);
    expect((await activityFeed(env.db, SCOPE)).map((item) => item.id)).toContain(SESSION);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect((await searchProject(env.db, SCOPE, { query: 'retentioncanary', mode: 'fts' })).results).toHaveLength(0);
    expect((await activityFeed(env.db, SCOPE)).map((item) => item.id)).not.toContain(SESSION);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM embedding_sources WHERE type='session'").get()).toEqual({ n: 0 });
    expect(await writeTitle(env.db, SCOPE.projectId, SESSION, 'returned', 'returned')).toBe(false);
    expect(await overwriteTitle(env.db, SCOPE.projectId, SESSION, 'returned', 'returned', 'mem_machine_1')).toBe(false);
  });

  it('answers not-applied for a session the Project never held, rather than inventing a tombstone', async () => {
    const { sqlite, env } = await rig();
    expect(await tombstoneSession(env, SCOPE, 'never-here', 'mem_machine_1', NOW)).toEqual({ applied: false, removed: 0, blobsFreed: 0, blobsLeft: 0 });
    expect(count(sqlite, 'session_tombstones')).toBe(0);
  });

  it('is idempotent: a second deletion changes nothing', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    const second = await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW + 1);
    expect(second.removed).toBe(0);
    expect(count(sqlite, 'session_tombstones')).toBe(1);
  });
});

describe('the blobs a deletion leaves', () => {
  const attach = (sqlite: Database, count: number, seed: string) => {
    for (let i = 0; i < count; i += 1) {
      const key = String(i).padStart(64, seed);
      registerBlob(sqlite, { projectId: SCOPE.projectId, key, size: 1, mediaType: 'image/png', receivedAt: NOW });
      sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
                  VALUES (?, ?, ?, 'e', ?, 'image/png', 1, ?, 't', ?)`, [SCOPE.projectId, `att-${i}`, SESSION, key, NOW, NOW]);
    }
  };

  it('releases every blob a large deletion frees in the deletion itself, however many pages it spans', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    attach(sqlite, RELEASE_PAGE * 2 + 5, 'a');
    const outcome = await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect([outcome.blobsFreed, outcome.blobsLeft]).toEqual([RELEASE_PAGE * 2 + 5, 0]);
    expect([count(sqlite, 'blobs'), count(sqlite, 'blob_release_candidates'), count(sqlite, 'object_releases')]).toEqual([0, 0, RELEASE_PAGE * 2 + 5]);
  });

  it('records every blob in the transaction that removes its rows, so an interruption before the release leaves them for the drain', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    attach(sqlite, RELEASE_PAGE + 3, 'b');
    let batches = 0;
    const interrupted = { ...env, db: { ...env.db, batch: async (statements: Parameters<typeof env.db.batch>[0]) => {
      batches += 1;
      // The key read and the deletion commit; the instance goes away before any release decision.
      if (batches > 2) throw new Error('the instance went away');
      return env.db.batch(statements);
    } } };
    await expect(tombstoneSession(interrupted as never, SCOPE, SESSION, 'mem_machine_1', NOW)).rejects.toThrow('went away');
    expect(count(sqlite, 'attachments')).toBe(0);
    expect(count(sqlite, 'blob_release_candidates')).toBe(RELEASE_PAGE + 3);
    // The tombstone window has closed, so the orphan sweep never runs again: the recorded candidates are what remains.
    while (count(sqlite, 'blob_release_candidates') > 0 || count(sqlite, 'object_releases') > 0) await drainObjectReleases(env, NOW + 7 * 86_400_000);
    expect([count(sqlite, 'blobs'), count(sqlite, 'object_releases')]).toEqual([0, 0]);
  });

  it('keeps every candidate recorded through a recovery hold that outlasts the tombstone window, and releases them all after it', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    attach(sqlite, RELEASE_PAGE + 3, 'c');
    expect(await acquireRecoveryHold(env.db, 'hold-1', NOW)).toBe(true);
    const outcome = await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect([outcome.blobsFreed, outcome.blobsLeft]).toEqual([0, RELEASE_PAGE + 3]);
    await drainObjectReleases(env, NOW + 7 * 86_400_000);
    expect([count(sqlite, 'blobs'), count(sqlite, 'blob_release_candidates')]).toEqual([RELEASE_PAGE + 3, RELEASE_PAGE + 3]);
    expect(await releaseRecoveryHold(env.db, 'hold-1', NOW + 7 * 86_400_000, 'closed')).toBe(true);
    while (count(sqlite, 'blob_release_candidates') > 0 || count(sqlite, 'object_releases') > 0) await drainObjectReleases(env, NOW + 7 * 86_400_000);
    expect(count(sqlite, 'blobs')).toBe(0);
  });
});

describe('the blobs a deleted session\'s tool calls and raw events name', () => {
  /** Where each blob a test stored its bytes; the name outlives the row that registered it. */
  const placed = new Map<string, string>();
  const readText = async (blobs: { get(key: string): Promise<{ body: ReadableStream } | null> }, key: string): Promise<string | null> => {
    const object = await blobs.get(placed.get(key)!);
    return object === null ? null : new Response(object.body).text();
  };
  const stored = async (sqlite: Database, blobs: { put(key: string, body: ReadableStream): Promise<unknown> }, key: string, text: string) => {
    const objectKey = registerBlob(sqlite, { projectId: SCOPE.projectId, key, size: text.length, receivedAt: NOW });
    placed.set(key, objectKey);
    await blobs.put(objectKey, new Blob([text]).stream());
  };
  const toolCall = (sqlite: Database, session: string, id: string, input: string | null, output: string | null) =>
    sqlite.run(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, input_blob_key, output_blob_key, success, created_at, token_id, received_at)
                VALUES (?, ?, ?, ?, 'Read', ?, ?, 1, ?, 't', ?)`, [SCOPE.projectId, id, session, `e-${id}`, input, output, NOW, NOW]);

  it('frees them with the session, and keeps a key another session\'s tool call shares', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    const [input, output, summary, shared] = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    for (const [key, text] of [[input, 'in'], [output, 'out'], [summary, 'summary'], [shared, 'shared']] as const) await stored(sqlite, env.blobs, key, text);
    toolCall(sqlite, SESSION, 'tc-deleted', input, output);
    toolCall(sqlite, SESSION, 'tc-deleted-shared', shared, null);
    toolCall(sqlite, 'other', 'tc-kept', null, shared);
    sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, blob_key)
                VALUES (?, 'e-cmp', ?, 't', 'compaction.pre', 'cli', '{}', 'h', ?, ?, ?)`, [SCOPE.projectId, SESSION, NOW, NOW, summary]);

    const outcome = await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect([outcome.blobsFreed, outcome.blobsLeft]).toEqual([3, 0]);
    // The deletion journals the freed objects; the drain is what deletes them from the store.
    expect(await readText(env.blobs, input)).toBe('in');
    expect((await drainObjectReleases(env, NOW)).deleted).toBe(3);
    expect(await readText(env.blobs, input)).toBeNull();
    expect(await readText(env.blobs, output)).toBeNull();
    expect(await readText(env.blobs, summary)).toBeNull();
    expect(await readText(env.blobs, shared)).toBe('shared');
    expect(sqlite.query(`SELECT key FROM blobs`).all()).toEqual([{ key: shared }]);
    // The sweep that follows a deletion finds nothing further to take from the survivor.
    expect(await freeOrphanedBlobs(env, NOW)).toBe(0);
  });
});

describe('a deleted session is absent from every read', () => {
  it('vanishes from the list, the summaries and the detail', async () => {
    const { env, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect((await listSessions(env.db, SCOPE)).rows).toEqual([]);
    expect((await listSessionSummaries(env.db, SCOPE, {}, NOW)).rows).toEqual([]);
    expect(await getSession(env.db, SCOPE, SESSION)).toBeNull();
  });

  it('is absent from each read that issues its own SELECT, asserted by name', async () => {
    const { env, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect({ read: 'sessionInScope', held: await sessionInScope(env.db, SCOPE, SESSION) }).toEqual({ read: 'sessionInScope', held: false });
    expect({ read: 'sessionHeldByMachine', held: await sessionHeldByMachine(env.db, SCOPE, SESSION, MACHINE) }).toEqual({ read: 'sessionHeldByMachine', held: false });
    expect({ read: 'projectHoldsSession', held: await projectHoldsSession(env.db, SCOPE, SESSION) }).toEqual({ read: 'projectHoldsSession', held: false });
    expect(await sessionCounts(env.db, SCOPE, SESSION)).toEqual({ prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 });
  });

  it('leaves the Project counting no sessions and holding no plans', async () => {
    const { env, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    const stats = await projectStats(env.db, SCOPE, NOW);
    expect({ sessions: stats.sessions, prompts: stats.prompts, plans: stats.plans }).toEqual({ sessions: 0, prompts: 0, plans: 0 });
    expect(await listProjectPlans(env.db, SCOPE)).toEqual([]);
  });

  it('suppresses only its own Project: the same session id elsewhere is untouched', async () => {
    const { sqlite, env, send } = await rig();
    await populate(send);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES ('proj_2', ?, ?, 't', ?, ?)`, [SESSION, MACHINE, NOW, NOW]);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    expect(await sessionInScope(env.db, { projectId: 'proj_2' }, SESSION)).toBe(true);
  });
});

describe('a deleted session takes no further writes', () => {
  it('refuses EVERY kind in the catalogue, which is what proves the check is shared rather than per handler', async () => {
    const { env, ctx, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);

    // One payload per kind, valid enough to reach admission; the tombstone is
    // what must stop each, never a bound.
    const payloads: Record<string, Record<string, unknown>> = {
      'session.start': { agent: 'claude-code' },
      'session.end': { endedAt: NOW },
      prompt: { promptId: uuid(60), text: 't', origin: 'user' },
      'tool.use': { toolCallId: uuid(61), toolName: 'Read', input: {}, success: true },
      'tool.failure': { toolCallId: uuid(62), toolName: 'Read', input: {}, success: false, errorMessage: 'e' },
      response: { responseId: uuid(63), text: 't' },
      plan: { planKey: uuid(64), content: '# p' },
      attachment: { attachmentId: uuid(65), blob: 'a'.repeat(64) },
      'transcript.segment': { transcriptId: uuid(66), baseOffset: 0, length: 1, blob: 'b'.repeat(64) },
      'compaction.pre': { trigger: 'auto' },
      'compaction.post': { trigger: 'auto' },
      'subagent.start': { subagentId: uuid(67) },
      'subagent.stop': { subagentId: uuid(68) },
      'stop.failure': { message: 'm' },
      'task.completed': { message: 'm' },
      notification: { message: 'm' },
      error: { message: 'm' },
    };

    let n = 100;
    for (const kind of KINDS.map((k) => k.name)) {
      const payload = payloads[kind];
      expect({ kind, covered: payload !== undefined }).toEqual({ kind, covered: true });
      n += 1;
      const result = await ingestEvent(env.db, ctx, envelope({ eventId: uuid(n), sessionId: SESSION, kind, payload }));
      expect({ kind, persisted: result.persisted }).toEqual({ kind, persisted: false });
    }
  });

  it('still admits a write to a session that carries no tombstone', async () => {
    const { env, ctx, send } = await rig();
    await populate(send);
    await tombstoneSession(env, SCOPE, SESSION, 'mem_machine_1', NOW);
    const other = await ingestEvent(env.db, ctx, envelope({ eventId: uuid(200), sessionId: 's2', kind: 'session.start', payload: { agent: 'codex' } }));
    expect(other.persisted).toBe(true);
  });
});
