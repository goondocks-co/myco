/**
 * The event spool against a refusal that is about the moment rather than the
 * record: the record, and every record of its session after it, stays spooled
 * in order behind a per-session wait, and a later pass delivers each once. A
 * refusal final for the record drops that record alone. A backlog walk honours
 * the wait; a session's own hooks and `myco member drain` send regardless. An
 * unclassified refusal of one record is final for it after a bounded hold.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import fs from 'node:fs';
import { run as runMemberCli } from '@myco/cli/member.js';
import { drainBacklog } from '@myco/member/backlog.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { REFUSAL_RETRY_INITIAL_MS, REFUSAL_RETRY_MAX_MS, UNCLASSIFIED_REFUSAL_HOLD_MS, type MemberCode } from '@myco/member/constants.js';
import { mintId, promptEvent, sessionStartEvent, type EnvelopeContext, type OutboundEvent } from '@myco/member/envelope.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

const PROJECT = 'proj_1';
const SERVER_URL = 'https://member-test.invalid';
const HOUR_MS = 60 * 60 * 1000;

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
});
afterEach(() => {
  setSystemTime();
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const clientFor = (rig: MemberRig, fetch: FetchLike) => new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, fetch);
const ctxFor = (spool: MemberSpool, sessionId: string, now?: () => number): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), now, version: '2.0.0-test' });
const prompt = (ctx: EnvelopeContext, text: string): OutboundEvent => promptEvent(ctx, { promptId: mintId(), text });
const idsOf = (events: readonly OutboundEvent[]): string[] => events.map((e) => e.envelope.eventId);
const storedIds = (rig: MemberRig, sessionId: string): string[] =>
  (rig.env.sqlite.query('SELECT event_id FROM events WHERE session_id = ? ORDER BY event_id').all(sessionId) as Array<{ event_id: string }>).map((r) => r.event_id);

interface Answer { eventId: string; sessionId: string; persisted: boolean; duplicate: boolean; code?: string }

/**
 * A fetch that records every `/events` answer, and answers an event `refuse`
 * names with a refusal of that code rather than forwarding it.
 */
function answering(rig: MemberRig, refuse: (envelope: { eventId: string; sessionId: string }) => MemberCode | null = () => null) {
  const answers: Answer[] = [];
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname !== '/events') return rig.fetch(req);
    const envelope = JSON.parse(await req.clone().text()) as { eventId: string; sessionId: string };
    const code = refuse(envelope);
    const res = code === null ? await rig.fetch(req) : Response.json({ persisted: false, code, reason: `refused ${code}` }, { headers: { 'x-myco-protocol': '1' } });
    const body = await res.clone().json() as { persisted?: boolean; duplicate?: boolean; code?: string };
    answers.push({ eventId: envelope.eventId, sessionId: envelope.sessionId, persisted: body.persisted === true, duplicate: body.duplicate === true, code: body.code });
    return res;
  };
  return { fetch, answers };
}

describe('an event refused for a passing reason', () => {
  it('resumes with clock_skew on the first drain and a working clock on the next: every event is delivered once, in order, with no duplicate row', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const t0 = Date.now();
    // The machine resumed from suspend with its clock an hour ahead of the Deployment's.
    const ahead = t0 + HOUR_MS;
    const before = ctxFor(spool, 'sess-skew', () => t0);
    const after = ctxFor(spool, 'sess-skew', () => ahead);
    const events = [sessionStartEvent(before, { startedAt: t0 }), prompt(before, 'before suspend'), prompt(after, 'after resume 1'), prompt(after, 'after resume 2'), prompt(after, 'after resume 3')];
    for (const e of events) spool.append('sess-skew', e);
    const ids = idsOf(events);
    const spy = answering(rig);

    const first = await spool.drainSession('sess-skew', clientFor(rig, spy.fetch), unboundedBudget(), { now: () => ahead });
    expect(first).toMatchObject({ sent: 3, acked: 2, refused: 0, remaining: 3, endedBy: 'refused' });
    expect(spy.answers.map((a) => [a.eventId, a.code ?? 'ok'])).toEqual([[ids[0], 'ok'], [ids[1], 'ok'], [ids[2], 'clock_skew']]);
    expect(readSessionState(spool.dir, 'sess-skew').eventRetry).toMatchObject({ heldId: ids[2], backoffMs: REFUSAL_RETRY_INITIAL_MS });
    expect(spool.readRefused().entries.map((e) => [e.eventId, e.code])).toEqual([[ids[2], 'clock_skew']]);
    expect(storedIds(rig, 'sess-skew')).toEqual([ids[0], ids[1]].sort());

    // The Deployment's clock reaches the member's; the session's own next hook sends at once.
    setSystemTime(new Date(ahead));
    const second = await spool.drainSession('sess-skew', clientFor(rig, spy.fetch), unboundedBudget(), { now: () => ahead });
    expect(second).toMatchObject({ acked: 3, refused: 0, remaining: 0, endedBy: 'drained' });

    const accepted = spy.answers.filter((a) => a.persisted);
    expect(accepted.map((a) => a.eventId)).toEqual(ids);
    expect(accepted.some((a) => a.duplicate)).toBe(false);
    expect(spy.answers.map((a) => a.eventId)).toEqual([ids[0], ids[1], ids[2], ids[2], ids[3], ids[4]]);
    expect(storedIds(rig, 'sess-skew')).toEqual([...ids].sort());
    expect(rig.rows('events')).toBe(ids.length);
    expect(readSessionState(spool.dir, 'sess-skew').eventRetry).toBeUndefined();
    expect(spool.sessionIds()).toEqual([]);
  });

  it('holds one session on its refusal and delivers every other session the walk reaches', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const held = ctxFor(spool, 'sess-a-held');
    const heldEvents = [sessionStartEvent(held, { startedAt: Date.now() }), prompt(held, 'a1'), prompt(held, 'a2')];
    // A kind this Deployment's version does not know yet: an older server.
    heldEvents[1].envelope.kind = 'future.kind' as never;
    for (const e of heldEvents) spool.append('sess-a-held', e);
    const other = ctxFor(spool, 'sess-b');
    const otherEvents = [sessionStartEvent(other, { startedAt: Date.now() }), prompt(other, 'b1')];
    for (const e of otherEvents) spool.append('sess-b', e);
    const spy = answering(rig);
    const t = Date.now();

    const walk = await drainBacklog(spool, clientFor(rig, spy.fetch), unboundedBudget(), { force: true, machineId: 'machine_1', now: () => t });
    expect(walk.sessions.map((s) => [s.sessionId, s.events?.endedBy, s.events?.remaining])).toEqual([['sess-a-held', 'refused', 2], ['sess-b', 'drained', 0]]);
    expect(walk.tried).toEqual(['sess-a-held', 'sess-b']);
    expect(walk.endedBy).toBe('done');
    expect(storedIds(rig, 'sess-b')).toEqual(idsOf(otherEvents).sort());
    expect(storedIds(rig, 'sess-a-held')).toEqual([heldEvents[0].envelope.eventId]);
    // The record after the held one was never offered: the session's order is kept.
    expect(spy.answers.map((a) => a.eventId)).not.toContain(heldEvents[2].envelope.eventId);
    expect(spool.depth('sess-a-held')).toBe(2);
  });

  it('is passed over by a backlog walk while its wait runs, sent once it has run out, and sent at once by `myco member drain`', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = ctxFor(spool, 'sess-wait');
    const events = [sessionStartEvent(ctx, { startedAt: Date.now() }), prompt(ctx, 'w1')];
    for (const e of events) spool.append('sess-wait', e);
    let refusals = 2;
    const spy = answering(rig, () => (refusals-- > 0 ? 'project_archived' : null));
    let t = Date.now();
    const walk = () => drainBacklog(spool, clientFor(rig, spy.fetch), unboundedBudget(), { force: true, machineId: 'machine_1', now: () => t });

    expect((await walk()).sessions[0].events).toMatchObject({ endedBy: 'refused', remaining: 2 });
    const wait = readSessionState(spool.dir, 'sess-wait').eventRetry!;
    expect(wait).toMatchObject({ at: t + REFUSAL_RETRY_INITIAL_MS, backoffMs: REFUSAL_RETRY_INITIAL_MS });

    t = wait.at - 1;
    const offered = spy.answers.length;
    const deferred = await walk();
    expect(deferred.sessions[0].events).toMatchObject({ skipped: 'deferred', sent: 0, remaining: 2 });
    expect(deferred.tried).toEqual([]);
    expect(spy.answers.length).toBe(offered);

    t = wait.at;
    expect((await walk()).sessions[0].events).toMatchObject({ sent: 1, endedBy: 'refused', remaining: 2 });
    const longer = readSessionState(spool.dir, 'sess-wait').eventRetry!;
    expect(longer.backoffMs).toBe(REFUSAL_RETRY_INITIAL_MS * 2);

    // Inside the new wait, an explicit drain sends regardless.
    const out: string[] = [];
    await runMemberCli(['drain'], { mycoHome, fetch: spy.fetch, now: () => t + 1, stdout: (l) => out.push(l), stderr: () => {} });
    expect(storedIds(rig, 'sess-wait')).toEqual(idsOf(events).sort());
    expect(spool.sessionIds()).toEqual([]);
    expect(spy.answers.filter((a) => a.persisted).map((a) => a.eventId)).toEqual(idsOf(events));
  });

  it('drops an unclassified refusal of one record once it has been refused for the hold at the longest wait, and delivers the records after it', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    const rig = await memberRig();
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = ctxFor(spool, 'sess-bad');
    const events = [prompt(ctx, 'never accepted'), sessionStartEvent(ctx, { startedAt: t0 })];
    for (const e of events) spool.append('sess-bad', e);
    const [bad, good] = idsOf(events);
    const spy = answering(rig, (e) => (e.eventId === bad ? 'refused' : null));
    const drain = () => spool.drainSession('sess-bad', clientFor(rig, spy.fetch), unboundedBudget(), { now: () => Date.now() });

    // Each hook of the session sends again; the wait doubles to its cap well inside the hold.
    for (let at = t0; at < t0 + UNCLASSIFIED_REFUSAL_HOLD_MS; at += 6 * HOUR_MS) {
      setSystemTime(new Date(at));
      expect(await drain()).toMatchObject({ endedBy: 'refused', remaining: 2, refused: 0 });
    }
    expect(readSessionState(spool.dir, 'sess-bad').eventRetry).toMatchObject({ heldId: bad, since: t0, backoffMs: REFUSAL_RETRY_MAX_MS });
    expect(storedIds(rig, 'sess-bad')).toEqual([]);

    setSystemTime(new Date(t0 + UNCLASSIFIED_REFUSAL_HOLD_MS));
    expect(await drain()).toMatchObject({ endedBy: 'drained', refused: 1, acked: 1, remaining: 0 });
    expect(storedIds(rig, 'sess-bad')).toEqual([good]);
    const logged = spool.readRefused().entries.at(-1)!;
    expect({ eventId: logged.eventId, code: logged.code, held: logged.reason.startsWith('refused for 72 h') }).toEqual({ eventId: bad, code: 'refused', held: true });
  });

  it('never drops a record for its age when the refusal names the Deployment, the clock or the server\'s version', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    const rig = await memberRig();
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = ctxFor(spool, 'sess-archived');
    spool.append('sess-archived', prompt(ctx, 'archived project'));
    const spy = answering(rig, () => 'project_archived');
    for (let at = t0; at <= t0 + 2 * UNCLASSIFIED_REFUSAL_HOLD_MS; at += 6 * HOUR_MS) {
      setSystemTime(new Date(at));
      expect(await spool.drainSession('sess-archived', clientFor(rig, spy.fetch), unboundedBudget(), { now: () => Date.now() })).toMatchObject({ endedBy: 'refused', refused: 0, remaining: 1 });
    }
  });

  it('drops a record whose staged bytes are gone when the Deployment holds none, and one whose bytes are refused for good, without holding the session', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool(PROJECT, { mycoHome });
    const ctx = ctxFor(spool, 'sess-bytes');
    const gone = prompt(ctx, 'g'.repeat(300_000));
    const capped = prompt(ctx, 'c'.repeat(300_001));
    const after = prompt(ctx, 'after');
    for (const e of [gone, capped, after]) spool.append('sess-bytes', e);
    fs.unlinkSync(gone.blobSource!.path);
    const blobCap: FetchLike = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === `/blobs/${capped.blobSource!.sha256}`) return Response.json({ stored: false, code: 'blob_cap', reason: 'too big' }, { headers: { 'x-myco-protocol': '1' } });
      return rig.fetch(req);
    };
    const spy = answering({ ...rig, fetch: blobCap });

    const result = await spool.drainSession('sess-bytes', clientFor(rig, spy.fetch), unboundedBudget());
    expect(result).toMatchObject({ refused: 2, acked: 1, remaining: 0, endedBy: 'drained' });
    expect(spool.readRefused().entries.map((e) => [e.eventId, e.code])).toEqual([[gone.envelope.eventId, 'blob_absent'], [capped.envelope.eventId, 'blob_cap']]);
    // The capped record's event was never offered: its bytes' refusal is its own.
    expect(spy.answers.map((a) => a.eventId)).toEqual([gone.envelope.eventId, after.envelope.eventId]);
    expect(storedIds(rig, 'sess-bytes')).toEqual([after.envelope.eventId]);
  });
});
