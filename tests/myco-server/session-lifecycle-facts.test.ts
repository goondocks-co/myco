/**
 * A session's lifecycle facts are the same whichever order its events arrive in, and survive duplicate delivery,
 * a document reset and a catch-up that builds them from history in bounded pages.
 */
import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { readDocumentStatus } from '@myco-server-worker/db/documents/status.js';
import { LIFECYCLE_PHASE, sessionLifecycleState } from '@myco-server-worker/db/documents/lifecycle.js';
import { cleanupCandidate } from '@myco-server-worker/core/storage-cleanup.js';
import { prepareArchive, eventArchiveStatements } from '@myco-server-worker/core/event-content.js';
import { sqliteD1, seededSqlite, seedCredential } from './helpers/d1.js';
import { envelope, memoryBlobStore, uuid } from './helpers/fixtures.js';
import { withDocumentStores, captureDocumentSession } from './helpers/document-stores.js';

const FACTS = `SELECT end_event_id,end_at,end_actor,import_end_event_id,import_end_at,latest_user_prompt_at,member_prompt_at,live_sources FROM session_lifecycle_facts WHERE session_id='s'`;

function rig() {
  const sqlite = seededSqlite();
  seedCredential(sqlite, { id: 'mt_1', machineId: 'machine_1', hash: 'h1' });
  const db = sqliteD1(sqlite);
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now: 100_000 };
  const send = async (event: { id: number; kind: string; at: number; channel?: string; payload: Record<string, unknown> }) => {
    const result = await ingestEvent(db, ctx, envelope({ eventId: uuid(event.id), sessionId: 's', kind: event.kind, createdAt: event.at, ...(event.channel === undefined ? {} : { channel: event.channel }), payload: event.payload }));
    expect(result.persisted).toBe(true);
  };
  return { sqlite, db, send };
}

const prompt = (id: number, identity: number, at: number) => ({ id, kind: 'prompt', at, payload: { promptId: uuid(900 + identity), text: `turn ${identity}`, origin: 'user' } });
const end = (id: number, at: number, channel?: string) => ({ id, kind: 'session.end', at, channel, payload: { endedAt: at } });
const start = (id: number, at: number) => ({ id, kind: 'session.start', at, payload: { agent: 'claude-code', startedAt: at } });

const permute = <T,>(items: readonly T[]): T[][] => items.length < 2 ? [[...items]]
  : items.flatMap((item, index) => permute([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));

const rebuild = async (db: RelationalStore) => {
  await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='session_lifecycle'").run();
  while (await catchUpPhase(db, LIFECYCLE_PHASE as never) > 0);
};
const forgetFacts = (db: RelationalStore, session: string) => db.batch(['session_lifecycle_facts', 'session_user_prompt_firsts']
  .map(table => db.prepare(`DELETE FROM ${table} WHERE session_id=?`).bind(session)));
const memberCtx = async (db: RelationalStore, session: string) => {
  const issued = await captureDocumentSession(db, 'project', session);
  return { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 100 };
};

describe('session lifecycle facts', () => {
  it('reach the same row and the same ended state in every delivery order, with the end the same as its provenance would pick', async () => {
    const events = [start(1, 100), prompt(2, 1, 200), end(3, 300), prompt(4, 2, 250), end(5, 300), prompt(6, 1, 500), start(7, 100)];
    const outcomes: unknown[] = [];
    for (const order of permute(events).slice(0, 8)) {
      const r = rig();
      for (const event of order) await r.send(event);
      outcomes.push({ facts: r.sqlite.query(FACTS).get(), start: r.sqlite.query(`SELECT facts_event_id,started_at,ended_at FROM sessions WHERE session_id='s'`).get() });
      r.sqlite.close();
    }
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]!);
    expect(outcomes[0]).toMatchObject({ start: { facts_event_id: uuid(1), started_at: 100, ended_at: 300 }, facts: { end_at: 300, end_event_id: uuid(3), latest_user_prompt_at: 250 } });
  });

  it('applies a late earlier copy of a prompt and ignores a replay at a later instant', async () => {
    const r = rig();
    await r.send(prompt(1, 1, 400));
    await r.send(end(2, 300));
    expect(r.sqlite.query(`SELECT ended_at FROM sessions WHERE session_id='s'`).get()).toEqual({ ended_at: null });
    await r.send(prompt(3, 1, 200));
    expect(r.sqlite.query(`SELECT ended_at FROM sessions WHERE session_id='s'`).get()).toEqual({ ended_at: 300 });
    await r.send(prompt(4, 1, 900));
    expect(r.sqlite.query(`SELECT ended_at,latest_user_prompt_at FROM sessions JOIN session_lifecycle_facts USING(project_id,session_id) WHERE session_id='s'`).get())
      .toEqual({ ended_at: 300, latest_user_prompt_at: 200 });
    r.sqlite.close();
  });

  it('lets one end win across lifecycle and stored end provenance, at an equal instant in either order', async () => {
    await withDocumentStores(async (db, target) => {
      const issued = await captureDocumentSession(db, 'project', 'seed');
      const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 100 };
      for (const [session, base, order] of [['forward', 0, [701, 702]], ['backward', 100, [702, 701]]] as const) {
        for (const id of order) {
          const actor = id === 701 ? 'member-one' : 'member-two';
          expect((await ingestEvent(db, { ...ctx, actor, writeOrigin: 'server' }, envelope({ eventId: uuid(base + id), sessionId: session, kind: 'session.end', createdAt: 300, channel: 'http',
            payload: { endedAt: 300, headSha: (id === 701 ? 'a' : 'b').repeat(40), dirty: false } }))).persisted, target).toBe(true);
        }
        const facts = await db.prepare('SELECT end_event_id,end_actor FROM session_lifecycle_facts WHERE session_id=?').bind(session).first();
        const provenance = await db.prepare("SELECT event_id,head_sha FROM knowledge_git_provenance WHERE session_id=? AND capture_point='session_end'").bind(session).first();
        expect(facts, target).toEqual({ end_event_id: uuid(base + 701), end_actor: 'member-one' });
        expect(provenance, target).toEqual({ event_id: uuid(base + 701), head_sha: 'a'.repeat(40) });
      }
    });
  });

  it('survive a document reset: the live document\'s turns count only for its generation', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 's');
      await db.batch([db.prepare(`UPDATE session_documents SET generation=generation+1,state='live' WHERE session_id='s'`),
        db.prepare(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
          SELECT project_id,session_id,generation,'doc-prompt','doc-prompt',1,'user',?1 FROM session_documents WHERE session_id='s'`).bind(9_000)]);
      await ingestEvent(db, ctx, envelope({ eventId: uuid(77), sessionId: 's', kind: 'session.end', createdAt: 8_000, payload: { endedAt: 8_000 } }));
      expect(await db.prepare(`SELECT ended_at FROM sessions WHERE session_id='s'`).first(), target).toEqual({ ended_at: null });
      await db.prepare(`UPDATE session_documents SET generation=generation+1 WHERE session_id='s'`).run();
      await ingestEvent(db, ctx, envelope({ eventId: uuid(78), sessionId: 's', kind: 'session.end', createdAt: 8_500, payload: { endedAt: 8_500 } }));
      expect(await db.prepare(`SELECT ended_at FROM sessions WHERE session_id='s'`).first(), target).toEqual({ ended_at: 8_500 });
    });
  });

  it('keep the end event\'s attribution through a rebuild even after a later prompt cleared it from the session', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'seed');
      await ingestEvent(db, { ...ctx, writeOrigin: 'server', actor: 'member' }, envelope({ eventId: uuid(402), sessionId: 'actor', kind: 'session.end', channel: 'http', createdAt: 300, payload: { endedAt: 300 } }));
      await ingestEvent(db, ctx, envelope({ eventId: uuid(403), sessionId: 'actor', kind: 'prompt', createdAt: 400, payload: { promptId: uuid(420), text: 'copy', origin: 'user' } }));
      expect(await db.prepare(`SELECT ended_at,ended_by FROM sessions WHERE session_id='actor'`).first(), target).toEqual({ ended_at: null, ended_by: null });
      await rebuild(db);
      await ingestEvent(db, ctx, envelope({ eventId: uuid(404), sessionId: 'actor', kind: 'prompt', createdAt: 200, payload: { promptId: uuid(420), text: 'copy', origin: 'user' } }));
      expect(await db.prepare(`SELECT ended_at,ended_by FROM sessions WHERE session_id='actor'`).first(), target).toEqual({ ended_at: 300, ended_by: 'member' });
    });
  });

  it('leave the authoritative start tuple untouched by a rebuild over an archived start', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'seed');
      const blobs = memoryBlobStore();
      const env = { db, blobs };
      await ingestEvent(db, ctx, envelope({ eventId: uuid(201), sessionId: 'archived', kind: 'session.start', channel: 'import', createdAt: 300, payload: { agent: 'claude-code', startedAt: 100 } }), env as never);
      await ingestEvent(db, ctx, envelope({ eventId: uuid(202), sessionId: 'archived', kind: 'session.start', createdAt: 200, payload: { agent: 'claude-code', startedAt: 200 } }), env as never);
      const before = await db.prepare("SELECT facts_event_id,started_at FROM sessions WHERE session_id='archived'").first();
      expect(before, target).toEqual({ facts_event_id: uuid(201), started_at: 100 });
      const source = await cleanupCandidate(db, { project_id: 'project', resource_id: uuid(201), resource_kind: 'event' }, true);
      await db.batch(eventArchiveStatements(db, source!, await prepareArchive(env as never, 'event', source!, Date.now())));
      await rebuild(db);
      expect(await db.prepare("SELECT facts_event_id,started_at FROM sessions WHERE session_id='archived'").first(), target).toEqual(before);
    });
  });

  it('settle a session that first arrives behind the catch-up cursor exactly as one captured once ready', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'seed');
      await db.prepare(`UPDATE projection_catchup SET done=0,after_key='["project","z",0,"z"]',frontier=NULL WHERE projection='session_lifecycle'`).run();
      const send = (id: number, kind: string, at: number, payload: Record<string, unknown>) => ingestEvent(db, ctx, envelope({ eventId: uuid(id), sessionId: 'a-new', kind, createdAt: at, payload }));
      await send(7001, 'session.end', 300, { endedAt: 300 });
      await send(7002, 'prompt', 400, { promptId: uuid(9001), text: 'later', origin: 'user' });
      expect(await db.prepare("SELECT ended_at FROM sessions WHERE session_id='a-new'").first(), target).toEqual({ ended_at: null });
      await send(7003, 'prompt', 200, { promptId: uuid(9001), text: 'later', origin: 'user' });
      expect(await db.prepare("SELECT ended_at FROM sessions WHERE session_id='a-new'").first(), target).toEqual({ ended_at: 300 });
      expect(await sessionLifecycleState(db, 'project', 'a-new'), target).toBe('ready');
    });
  });

  it.each([
    ['a prompt no user typed', { kind: 'prompt', payload: { promptId: uuid(9101), text: 'injected', origin: 'hook_injected' } }],
    ['a title-only import end', { kind: 'session.end', channel: 'import', payload: { title: 'named' } }],
  ] as const)('settle a session behind the cursor that opens with %s', async (_name, opening) => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'seed');
      await db.prepare(`UPDATE projection_catchup SET done=0,after_key='["project","z",0,"z"]',frontier=NULL WHERE projection='session_lifecycle'`).run();
      const send = (id: number, kind: string, at: number, payload: Record<string, unknown>, channel?: string) =>
        ingestEvent(db, ctx, envelope({ eventId: uuid(id), sessionId: 'a-other', kind, createdAt: at, payload, ...(channel === undefined ? {} : { channel }) }));
      await send(7201, opening.kind, 100, opening.payload, 'channel' in opening ? opening.channel : undefined);
      await send(7202, 'session.end', 300, { endedAt: 300 });
      await send(7203, 'prompt', 400, { promptId: uuid(9102), text: 'later', origin: 'user' });
      await send(7204, 'prompt', 200, { promptId: uuid(9102), text: 'later', origin: 'user' });
      expect(await db.prepare("SELECT ended_at FROM sessions WHERE session_id='a-other'").first(), target).toEqual({ ended_at: 300 });
    });
  });

  it('carry an end\'s attribution from before events recorded it through the walk and later settles', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'older');
      const at = (await db.prepare("SELECT MAX(created_at) at FROM events WHERE session_id='older'").first<{ at: number }>())!.at + 1000;
      expect((await ingestEvent(db, ctx, envelope({ eventId: uuid(7101), sessionId: 'older', kind: 'session.end', createdAt: at, payload: { endedAt: at } }))).persisted, target).toBe(true);
      await db.prepare("UPDATE events SET actor=NULL WHERE session_id='older'").run();
      await db.prepare("UPDATE sessions SET ended_by='member' WHERE session_id='older'").run();
      await forgetFacts(db, 'older');
      await rebuild(db);
      expect(await db.prepare("SELECT ended_by FROM sessions WHERE session_id='older'").first(), target).toEqual({ ended_by: 'member' });
      expect(await db.prepare("SELECT actor FROM events WHERE session_id='older' AND kind='session.end'").first(), target).toEqual({ actor: 'member' });
      expect(await db.prepare("SELECT end_actor FROM session_lifecycle_facts WHERE session_id='older'").first(), target).toEqual({ end_actor: 'member' });
    });
  });

  it('build a historical session in pages, reporting building and holding decisions provisional until the walk passes it', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 'history');
      // History the upgrade found: no facts row, and a phase that has not walked it.
      await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<120)
        INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
        SELECT 'project','history-'||i,'history',?,'prompt','cli',json_object('promptId','prompt-'||i,'origin','user'),'hash',1000+i,1000+i FROM seq`).bind(ctx.tokenId).run();
      await forgetFacts(db, 'history');
      await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='session_lifecycle'").run();

      // An end that history will overrule is applied provisionally, without reading history.
      await ingestEvent(db, ctx, envelope({ eventId: uuid(5000), sessionId: 'history', kind: 'session.end', createdAt: 1050, payload: { endedAt: 1050 } }));
      expect(await db.prepare("SELECT ended_at FROM sessions WHERE session_id='history'").first(), target).toEqual({ ended_at: 1050 });
      expect(await sessionLifecycleState(db, 'project', 'history'), target).toBe('building');

      let pages = 0, keys = 0;
      for (let n = await catchUpPhase(db, LIFECYCLE_PHASE as never); n > 0; n = await catchUpPhase(db, LIFECYCLE_PHASE as never)) { pages += 1; keys += n; }
      expect(pages, target).toBeGreaterThan(1);
      expect(keys, target).toBeLessThanOrEqual(130);
      expect(await sessionLifecycleState(db, 'project', 'history'), target).toBe('ready');
      expect(await db.prepare("SELECT ended_at FROM sessions WHERE session_id='history'").first(), target).toEqual({ ended_at: null });
      expect(await db.prepare("SELECT latest_user_prompt_at FROM session_lifecycle_facts WHERE session_id='history'").first(), target).toEqual({ latest_user_prompt_at: 1120 });
    });
  });

  it('are rebuilt in full by the catch-up, with status reporting building until it finishes', async () => {
    await withDocumentStores(async (db, target) => {
      const ctx = await memberCtx(db, 's');
      await ingestEvent(db, ctx, envelope({ eventId: uuid(60), sessionId: 's', kind: 'session.end', createdAt: 1_000, payload: { endedAt: 1_000 } }));
      const before = await db.prepare(FACTS).first();
      await forgetFacts(db, 's');
      await db.batch([db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='session_lifecycle'")]);
      expect(await readDocumentStatus(db), target).toMatchObject({ lifecycle: 'building' });
      while (await catchUpPhase(db, LIFECYCLE_PHASE as never) > 0);
      expect(await db.prepare(FACTS).first(), target).toEqual(before);
      expect(await readDocumentStatus(db), target).toMatchObject({ lifecycle: 'ready' });
    });
  });
});
