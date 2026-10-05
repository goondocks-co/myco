/**
 * A member that could not deliver for a while — offline past its token's TTL,
 * or holding a credential the Deployment refuses — through the real hooks and
 * the in-process worker.
 *
 * A lapsed token of a lineage refreshed within the inactivity bound renews on
 * the first hook back and that hook delivers on it, however old the lineage. A refusal that is final is recorded and said, on stderr and in
 * the session-start injection. What was captured meanwhile, the turn-end
 * transcript included, stays on disk and reaches the Deployment once a new
 * credential is in place, from the next probing hook of any session, after
 * that session's own delivery and inside its budget — once, with no turn
 * doubled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueMemberToken, MEMBER_LINEAGE_IDLE_MS } from '@myco-server-worker/auth/tokens.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { run as runMemberCli } from '@myco/cli/member.js';
import { agentOfSession, drainBacklog } from '@myco/member/backlog.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { recordJoinAnswer } from '@myco/member/join-code.js';
import { refreshDue, refreshMembership } from '@myco/member/refresh.js';
import { readRegistryEntry, writeDeploymentMembership } from '@myco/member/registry.js';
import { emptySessionState, readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { ServerClient } from './helpers/env-client.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const NOT_DELIVERED = 'capture is not being delivered';
const INACTIVE = 'the machine was inactive too long, or its credential ended';
const TWO_PLACES = 'was used from two places and has been revoked for safety';

let mycoHome: string;
let root: string;
const savedHome = process.env.MYCO_HOME;

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  root = resolveMemberProjectRoot(process.cwd());
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

const transcript = (sessionId: string, text: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-tx-')), `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'user', cwd: '/work/repo', promptId: `p-${sessionId}`, uuid: `u-${sessionId}`, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } },
    { type: 'assistant', uuid: `a-${sessionId}`, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }], stop_reason: 'end_turn' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

/** One whole session as its hooks run it: start, a turn end that ships the transcript, and the end. */
async function session(fetchImpl: Parameters<typeof runHook>[2]['fetch'], sessionId: string, text: string) {
  const tx = transcript(sessionId, text);
  const start = await runHook('session-start', { session_id: sessionId, hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: fetchImpl });
  const stop = await runHook('stop', { session_id: sessionId, hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: `re: ${text}` }, { helpers: 'run', fetch: fetchImpl });
  const end = await runHook('session-end', { session_id: sessionId, hook_event_name: 'SessionEnd', transcript_path: tx }, { helpers: 'run', fetch: fetchImpl });
  return { tx, start, stop, end };
}

async function parseAll(rig: MemberRig): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) if ((await parseTranscripts(rig.env.serverEnv, Date.now())).changed === 0) return;
}

const prompts = (rig: MemberRig): string[] =>
  (rig.env.sqlite.query('SELECT text FROM prompt_batches ORDER BY text').all() as Array<{ text: string }>).map((r) => r.text);
const segmentsOf = (rig: MemberRig, sessionId: string): number =>
  (rig.env.sqlite.query('SELECT COUNT(*) AS n FROM transcript_segments s JOIN transcripts t ON t.transcript_id = s.transcript_id WHERE t.session_id = ?').get(sessionId) as { n: number }).n;
const revoke = (rig: MemberRig, tokenId: string): void => { rig.env.sqlite.query('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), tokenId); };

/** A second holder of the credential, acting on the Deployment directly: rotating a token and capturing on the result. */
const secondHolder = (rig: MemberRig) => ({
  rotate: async (token: string) => {
    const res = await rig.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: rig.headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }), body: '{}' }));
    const body = await res.json() as { refreshed: boolean; token: string; tokenId: string };
    expect(body.refreshed).toBe(true);
    return body;
  },
  capture: (token: string) => rig.fetch(new Request('https://s/events', {
    method: 'POST', headers: rig.headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
    body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: `thief-${crypto.randomUUID()}`, kind: 'session.start', createdAt: Date.now(), channel: 'cli', producer: { adapter: 'thief', version: '1' }, payload: { agent: 'claude-code', startedAt: Date.now() } }),
  })),
});
const liveRows = (rig: MemberRig): number =>
  (rig.env.sqlite.query('SELECT COUNT(*) AS n FROM member_credentials WHERE revoked_at IS NULL').get() as { n: number }).n;

describe('a credential used from two places', () => {
  it('thief first: the owner\'s next hook, refused, rotates with the head the thief moved past — which revokes the whole lineage, the thief\'s successor included — and says why', async () => {
    const rig = await memberRig({ now: Date.now() - 6.5 * DAY_MS });
    // The registry believes no rotation is due, so the hook's first dial is capture, not a refresh.
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: Date.now() + 5 * DAY_MS, serverUrl: SERVER_URL });
    const thief = secondHolder(rig);
    const stolen = await thief.rotate(rig.token);
    expect((await thief.capture(stolen.token)).status).toBe(200);
    const spy = recordingFetch(rig.fetch);

    const tx = transcript('sess-owner', 'mine');
    const start = await runHook('session-start', { session_id: 'sess-owner', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });

    // The hook's first dials are its own work, refused; the rotation it forces follows them.
    const paths = spy.requests.map((r) => r.path);
    expect(paths[0]).not.toBe('/tokens/refresh');
    expect(paths.indexOf('/tokens/refresh')).toBeGreaterThan(0);
    expect(liveRows(rig)).toBe(0);
    expect((await thief.capture(stolen.token)).status).toBe(401);
    const held = readRegistryEntry(root, mycoHome)!;
    expect({ terminal: held.refreshTerminal, reason: held.refreshTerminalReason }).toEqual({ terminal: true, reason: 'replayed' });
    expect(start.stderr).toContain(TWO_PLACES);
    // The hook answered before its helper learned why; the next session's start tells the agent.
    const next = await runHook('session-start', { session_id: 'sess-owner-next', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });
    expect(next.stdout).toContain(TWO_PLACES);
    expect(next.stdout).toContain('myco login <link>');
    expect(new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome }).depth('sess-owner')).toBe(1);
  });

  it('a thief who rotated the head after the owner had, before the owner used its successor: the owner\'s passed-over successor, refused, rotates — and the lineage is revoked the same way', async () => {
    const rig = await memberRig({ now: Date.now() - 6.5 * DAY_MS });
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: rig.fetch, budget: unboundedBudget() })).status).toBe('refreshed');
    const owners = readRegistryEntry(root, mycoHome)!;
    const thief = secondHolder(rig);
    const stolen = await thief.rotate(rig.token);
    expect((await thief.capture(stolen.token)).status).toBe(200);
    const spy = recordingFetch(rig.fetch);

    const tx = transcript('sess-owner-2', 'mine too');
    const start = await runHook('session-start', { session_id: 'sess-owner-2', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });

    expect(spy.requests[0].path).not.toBe('/tokens/refresh');
    expect(spy.requests.some((r) => r.path === '/tokens/refresh')).toBe(true);
    expect(readRegistryEntry(root, mycoHome)!.token).toBe(owners.token);
    expect(liveRows(rig)).toBe(0);
    expect((await thief.capture(stolen.token)).status).toBe(401);
    expect(readRegistryEntry(root, mycoHome)!.refreshTerminalReason).toBe('replayed');
    expect(start.stderr).toContain(TWO_PLACES);
    const next = await runHook('session-start', { session_id: 'sess-owner-2-next', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });
    expect(next.stdout).toContain(TWO_PLACES);
  });

  it('a re-login clears the reason with the rest of the replaced token\'s state', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: 'x'.repeat(43), tokenId: 'mt_old', projectId: PROJECT, expiresAt: Date.now() - DAY_MS, serverUrl: SERVER_URL });
    const held = readRegistryEntry(root, mycoHome)!;
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: held.token, tokenId: held.tokenId, expiresAt: held.expiresAt, machineId: held.machineId, joinedAt: 1, updatedAt: 1, refreshTerminal: true, refreshTerminalReason: 'replayed' }, { mycoHome });
    expect(readRegistryEntry(root, mycoHome)!.refreshTerminalReason).toBe('replayed');
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: rig.token, tokenId: rig.tokenId, expiresAt: rig.expiresAt, machineId: held.machineId, joinedAt: 1, updatedAt: 2 }, { mycoHome });
    const fresh = readRegistryEntry(root, mycoHome)!;
    expect({ terminal: fresh.refreshTerminal, reason: fresh.refreshTerminalReason }).toEqual({ terminal: undefined, reason: undefined });
  });
});

describe('a member that could not deliver', () => {
  it('renews a token that lapsed offline on its first hook back, before anything else is dialled, and delivers the session on it', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    expect(rig.expiresAt).toBeLessThan(Date.now());
    const spy = recordingFetch(rig.fetch);

    const { start } = await session(spy.fetch, 'sess-back', 'after the holiday');

    expect(spy.requests[0].path).toBe('/tokens/refresh');
    const renewed = readRegistryEntry(root, mycoHome)!;
    expect(renewed.token).not.toBe(rig.token);
    expect(renewed.refreshTerminal).toBeUndefined();
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    expect(start.stderr).not.toContain(NOT_DELIVERED);
    expect(rig.rows('sessions')).toBe(1);
    expect(segmentsOf(rig, 'sess-back')).toBe(1);
    await parseAll(rig);
    expect(prompts(rig)).toEqual(['after the holiday']);
    expect(new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome }).sessionIds()).toEqual([]);
  });

  it('renews a lapsed token of a lineage that started long past the inactivity bound but kept refreshing', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    rig.env.sqlite.query('UPDATE member_credentials SET lineage_started_at = ? WHERE id = ?').run(Date.now() - 2 * MEMBER_LINEAGE_IDLE_MS, rig.tokenId);
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    const { start } = await session(spy.fetch, 'sess-old-lineage', 'a year of daily use');

    expect(spy.requests[0].path).toBe('/tokens/refresh');
    const renewed = readRegistryEntry(root, mycoHome)!;
    expect(renewed.token).not.toBe(rig.token);
    expect(renewed.refreshTerminal).toBeUndefined();
    expect(start.stderr).not.toContain(NOT_DELIVERED);
    expect(segmentsOf(rig, 'sess-old-lineage')).toBe(1);
  });

  it('says so at the point of use once the machine has been silent past the inactivity bound, and keeps what it captures', async () => {
    const rig = await memberRig({ now: Date.now() - MEMBER_LINEAGE_IDLE_MS - DAY_MS });
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    const tx = transcript('sess-ended', 'nobody hears this');
    const start = await runHook('session-start', { session_id: 'sess-ended', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });

    expect(readRegistryEntry(root, mycoHome)!.refreshTerminal).toBe(true);
    expect(start.stderr).toContain('myco login <link>');
    expect(start.stderr).toContain('inactive too long');
    // The hook answered before its helper learned the credential ended; the next session's start says so.
    const next = await runHook('session-start', { session_id: 'sess-ended-next', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });
    expect(next.stderr).toContain(NOT_DELIVERED);
    expect(next.stdout).toContain(NOT_DELIVERED);
    expect(next.stdout).toContain(INACTIVE);
    expect(rig.rows('member_credentials')).toBe(1);
    expect(rig.rows('sessions')).toBe(0);
    expect(new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome }).depth('sess-ended')).toBe(1);

    // Terminal: a later hook asks the refresh route nothing, and still says so.
    const refreshes = spy.requests.filter((r) => r.path === '/tokens/refresh').length;
    const stop = await runHook('stop', { session_id: 'sess-ended', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: spy.fetch });
    expect(spy.requests.filter((r) => r.path === '/tokens/refresh').length).toBe(refreshes);
    expect(stop.stderr).toContain(NOT_DELIVERED);
  });

  it('delivers a session captured while refused — events and turn-end transcript — from the next session\'s turn end after a re-login, after that session\'s own delivery, once', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    revoke(rig, rig.tokenId);
    const spy = recordingFetch(rig.fetch);

    const refused = await session(spy.fetch, 'sess-refused', 'captured while refused');
    // The session's start answered before its helper was refused; its Stop says so.
    expect(refused.stop.stderr).toContain(NOT_DELIVERED);
    expect(rig.rows('sessions')).toBe(0);
    expect(readRegistryEntry(root, mycoHome)!.refreshTerminal).toBe(true);
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    expect(spool.depth('sess-refused')).toBe(3);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-refused']);

    // A re-login replaces the credential and every piece of the old token's rotation state.
    const fresh = await issueMemberToken(rig.env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    recordJoinAnswer({ serverUrl: SERVER_URL, key: 'k' }, { memberId: 'mem_machine_1', token: fresh.token, tokenId: fresh.tokenId, expiresAt: fresh.expiresAt, role: 'member', projectId: PROJECT }, { mycoHome, root });
    const rejoined = readRegistryEntry(root, mycoHome)!;
    expect({ token: rejoined.token, refreshTerminal: rejoined.refreshTerminal, refreshAfter: rejoined.refreshAfter }).toEqual({ token: fresh.token, refreshTerminal: undefined, refreshAfter: undefined });
    expect(refreshDue(rejoined, Date.now())).toBe(false);

    const seen = spy.requests.length;
    const next = await session(spy.fetch, 'sess-next', 'first turn after re-login');
    expect(next.start.stderr).not.toContain(NOT_DELIVERED);

    // The helper walks the session a person is working in first, then the backlog, each session's records in order.
    const order = (rig.env.sqlite.query(`SELECT session_id AS s, kind AS k FROM events WHERE producer_adapter <> 'transcript-parse' AND kind <> 'turn' ORDER BY received_at, rowid`).all() as Array<{ s: string; k: string }>)
      .map((r) => `${r.s} ${r.k}`);
    expect(order[0]).toBe('sess-next session.start');
    expect(order.filter((o) => o.startsWith('sess-refused'))).toEqual(['sess-refused session.start', 'sess-refused session.end', 'sess-refused session.end', 'sess-refused transcript.segment']);
    expect(order).toContain('sess-next transcript.segment');
    expect(spy.requests.slice(seen).every((r) => r.path !== '/tokens/refresh')).toBe(true);

    expect(segmentsOf(rig, 'sess-refused')).toBe(1);
    expect(spool.sessionIds()).toEqual([]);
    expect(spool.transcriptBacklogIds()).toEqual([]);
    await parseAll(rig);
    expect(prompts(rig)).toEqual(['captured while refused', 'first turn after re-login']);

    // Nothing is delivered twice: another turn end, and an explicit drain, add no captured row (a turn end is its own).
    const capturedEvents = () => (rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE kind <> 'turn'`).get() as { n: number }).n;
    const counts = () => [capturedEvents(), ...['transcript_segments', 'prompt_batches', 'responses'].map((t) => rig.rows(t))];
    const before = counts();
    await runHook('stop', { session_id: 'sess-next', hook_event_name: 'Stop', transcript_path: next.tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: spy.fetch });
    await runMemberCli(['drain'], { mycoHome, fetch: spy.fetch, stdout: () => {}, stderr: () => {} });
    await parseAll(rig);
    expect(counts()).toEqual(before);
  });

  for (const recovery of ['turn end', 'member drain'] as const) {
    it(`keeps a session captured offline more than 30 days ago, transcript pointer included, and delivers it by ${recovery} once back`, async () => {
      const rig = await memberRig();
      registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
      const offline: typeof rig.fetch = async () => { throw new TypeError('fetch failed'); };
      const longAgo = Date.now() - 32 * DAY_MS;
      const tx = transcript('sess-early', 'written early in the outage');
      for (const [hook, raw] of [
        ['session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }],
        ['stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }],
      ] as const) await runHook(hook, { session_id: 'sess-early', ...raw }, { helpers: 'run', fetch: offline, now: () => longAgo });
      const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
      expect(spool.transcriptBacklogIds()).toEqual(['sess-early']);

      // Still offline, 32 days on: a turn end of another session runs retention and must not quarantine what nothing could deliver.
      await runHook('stop', { session_id: 'sess-late', hook_event_name: 'Stop', transcript_path: transcript('sess-late', 'late'), last_assistant_message: 'x' }, { helpers: 'run', fetch: offline });
      expect(spool.sessionIds()).toEqual(['sess-early']);
      expect(readSessionState(spool.dir, 'sess-early').transcript?.path).toBe(tx);

      if (recovery === 'turn end') {
        await runHook('stop', { session_id: 'sess-back', hook_event_name: 'Stop', transcript_path: transcript('sess-back', 'back'), last_assistant_message: 'x' }, { helpers: 'run', fetch: rig.fetch });
      } else {
        await runMemberCli(['drain'], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
      }
      expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-early' AND kind = 'session.start'`).get()).toEqual({ n: 1 });
      expect(segmentsOf(rig, 'sess-early')).toBe(1);
      expect(fs.existsSync(path.join(spool.dir, 'quarantine', 'sess-early.jsonl'))).toBe(false);
    });
  }

  it('walks the session that kicked first, and leaves the backlog its pass had no time for to its successor', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    revoke(rig, rig.tokenId);
    await session(rig.fetch, 'sess-waiting', 'waiting');
    const fresh = await issueMemberToken(rig.env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    recordJoinAnswer({ serverUrl: SERVER_URL, key: 'k' }, { memberId: 'mem_machine_1', token: fresh.token, tokenId: fresh.tokenId, expiresAt: fresh.expiresAt, role: 'member', projectId: PROJECT }, { mycoHome, root });

    // The owning session's own transcript segment spends the rest of the budget.
    let t = Date.now();
    const spent: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      const body = await req.clone().text();
      const res = await rig.fetch(req);
      if (new URL(req.url).pathname === '/events' && body.includes('"transcript.segment"')) t += 60 * 60 * 1000;
      return res;
    };
    const spy = recordingFetch(spent);
    const tx = transcript('sess-busy', 'busy');
    await runHook('stop', { session_id: 'sess-busy', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: spy.fetch, now: () => t });

    expect(segmentsOf(rig, 'sess-busy')).toBe(1);
    // The pass that shipped it ran out of time; its successor delivered the backlog, after it.
    const order = (rig.env.sqlite.query(`SELECT session_id AS s FROM events WHERE kind <> 'turn' ORDER BY received_at, rowid`).all() as Array<{ s: string }>).map((r) => r.s);
    expect(order[0]).toBe('sess-busy');
    expect(order).toContain('sess-waiting');
    expect(spool.depth('sess-waiting')).toBe(0);
    expect(spool.transcriptBacklogIds()).toEqual([]);
  });

  it('delivers a transcript a build that recorded no symbiont left behind, naming the agent from the declared layout', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const savedUserHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-userhome-'));
    process.env.HOME = home;
    try {
      const sessionId = 'sess-legacy';
      const dir = path.join(home, '.claude', 'projects', '-work-repo');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.copyFileSync(transcript(sessionId, 'left behind'), file);
      const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
      const inode = Number(fs.statSync(file).ino);
      updateSessionState(spool.dir, sessionId, (s) => {
        s.transcript = transcriptPointerFor(file, 'machine_1')!;
      });
      expect(readSessionState(spool.dir, sessionId).agent).toBeUndefined();
      expect(agentOfSession(sessionId, readSessionState(spool.dir, sessionId))).toBe('claude-code');
      expect(agentOfSession(sessionId, { ...emptySessionState(), transcript: { path: path.join(home, 'elsewhere.jsonl'), transcriptId: 'x', inode, nextOffset: 0, parsedSize: 0 } })).toBeNull();

      const client = new ServerClient(readRegistryEntry(root, mycoHome)!, rig.fetch);
      const report = await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' });
      expect(report).toEqual({ endedBy: 'done', sessions: [{ sessionId, transcripts: { shipped: 1, endedBy: 'done' } }] });
      expect(rig.env.sqlite.query('SELECT agent FROM transcripts WHERE session_id = ?').get(sessionId)).toEqual({ agent: 'claude-code' });
      expect(spool.transcriptBacklogIds()).toEqual([]);
      expect(readSessionState(spool.dir, sessionId).agent).toBe('claude-code');
    } finally {
      if (savedUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedUserHome;
    }
  });
});

describe('the backlog walk', () => {
  /** A session that ended with its transcript undelivered: the pointer and the mark, and no hook left to fire. */
  const stranded = (spool: MemberSpool, sessionId: string, agent: string | null = 'claude-code'): string => {
    const file = transcript(sessionId, `stranded ${sessionId}`);
    spool.appendAndRecord(sessionId, [], (state) => {
      if (agent !== null) state.agent = agent;
      state.transcript = transcriptPointerFor(file, 'machine_1')!;
    });
    return file;
  };
  const blobUploads = (spy: ReturnType<typeof recordingFetch>): number => spy.requests.filter((r) => r.path.startsWith('/blobs/')).length;

  it('leaves a session whose lease another process holds to that process, and delivers it once the lease is free', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    stranded(spool, 'sess-held');
    const spy = recordingFetch(rig.fetch);
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, spy.fetch);

    const held = await spool.withSessionLease('sess-held', () => drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' }));
    expect(held).toEqual({ endedBy: 'skipped', sessions: [{ sessionId: 'sess-held', transcripts: 'lease' }] });
    expect(blobUploads(spy)).toBe(0);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-held']);

    const free = await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(free.endedBy).toBe('done');
    expect(segmentsOf(rig, 'sess-held')).toBe(1);
  });

  it('ships a turn end\'s own transcript only under the session lease', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const tx = transcript('sess-own', 'own');
    await spool.withSessionLease('sess-own', () => runHook('stop', { session_id: 'sess-own', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: rig.fetch }));
    expect(segmentsOf(rig, 'sess-own')).toBe(0);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-own']);
  });

  it('gives up on a transcript the Deployment refuses for good: logged once, never uploaded again, by a turn end or by `member drain`', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    stranded(spool, 'sess-refused');
    const refusing: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname.startsWith('/blobs/')) return Response.json({ stored: false, code: 'media_type', reason: 'refused' }, { headers: { 'x-myco-protocol': '1' } });
      return rig.fetch(req);
    };
    const spy = recordingFetch(refusing);
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, spy.fetch);

    await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(blobUploads(spy)).toBe(1);
    expect(spool.transcriptBacklogIds()).toEqual([]);
    expect(readSessionState(spool.dir, 'sess-refused').transcript?.refused).toBe('media_type');

    await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1', rescan: true });
    await runMemberCli(['drain'], { mycoHome, fetch: spy.fetch, stdout: () => {}, stderr: () => {} });
    expect(blobUploads(spy)).toBe(1);
    expect(spool.readRefused().entries.map((e) => e.code)).toEqual(['media_type']);
  });

  it('keeps and reports a session no single symbiont can be named for, and does not search for one again on every turn end', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const file = stranded(spool, 'sess-unnamed', null);
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, rig.fetch);

    const report = await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(report.sessions).toEqual([{ sessionId: 'sess-unnamed', transcripts: 'no-agent' }]);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-unnamed']);
    expect(readSessionState(spool.dir, 'sess-unnamed').agentUnknown).toBe(true);
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { said.push(String(c)); return true; }) as never;
    try {
      expect((await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' })).sessions).toEqual([{ sessionId: 'sess-unnamed', transcripts: 'no-agent' }]);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = write;
    }
    expect(said.join('')).not.toContain('no one symbiont');

    // Two layouts that both name the file: no guess.
    const layout = { roots: [path.dirname(file)], patterns: ['{sessionId}.jsonl'], retention: 'harness' as const };
    const state = readSessionState(spool.dir, 'sess-unnamed');
    expect(agentOfSession('sess-unnamed', state, [{ name: 'a', capture: { transcriptDiscovery: layout } }, { name: 'b', capture: { transcriptDiscovery: layout } }])).toBeNull();
    expect(agentOfSession('sess-unnamed', state, [{ name: 'a', capture: { transcriptDiscovery: layout } }, { name: 'b' }])).toBe('a');
  });

  it('delivers the rest of the backlog when a turn end could not deliver its own session: each session is held on its own', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    stranded(spool, 'sess-waiting');
    // The Deployment answers this turn end's own events with a reslice: nothing it cannot retry, and no latch, yet not delivered.
    const ownRefused: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      const body = req.method === 'POST' ? await req.clone().text() : '';
      if (new URL(req.url).pathname === '/events' && body.includes('"sess-own"')) {
        return Response.json({ persisted: false, code: 'offset_gap', reason: 'gap', transcript: { size: 0 } }, { headers: { 'x-myco-protocol': '1' } });
      }
      return rig.fetch(req);
    };
    const tx = transcript('sess-own', 'own');
    await runHook('session-start', { session_id: 'sess-own', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { helpers: 'run', fetch: ownRefused });
    await runHook('stop', { session_id: 'sess-own', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: ownRefused });

    expect(spool.depth('sess-own')).toBeGreaterThan(0);
    expect(segmentsOf(rig, 'sess-waiting')).toBe(1);
    expect(spool.transcriptBacklogIds()).not.toContain('sess-waiting');
  });

  it('asks once more about a terminal refusal another build recorded, renews a lapsed token of a live lineage on it, and never asks twice about its own', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: rig.token, refreshTerminal: true, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    expect(readRegistryEntry(root, mycoHome)).toMatchObject({ refreshTerminal: true, refreshTerminalBy: undefined });
    const spy = recordingFetch(rig.fetch);

    await session(spy.fetch, 'sess-after-upgrade', 'after the upgrade');
    const renewed = readRegistryEntry(root, mycoHome)!;
    expect({ renewed: renewed.token !== rig.token, terminal: renewed.refreshTerminal }).toEqual({ renewed: true, terminal: undefined });
    expect(segmentsOf(rig, 'sess-after-upgrade')).toBe(1);

    // This build's own terminal refusal is final: no hook asks again.
    revoke(rig, renewed.tokenId!);
    await runHook('session-start', { session_id: 'sess-refused', hook_event_name: 'SessionStart', transcript_path: transcript('sess-refused', 'r'), cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });
    const refused = readRegistryEntry(root, mycoHome)!;
    expect(refused.refreshTerminal).toBe(true);
    expect(refused.refreshTerminalBy).toBeDefined();
    const dials = spy.requests.filter((r) => r.path === '/tokens/refresh').length;
    for (let i = 0; i < 3; i += 1) await runHook('session-start', { session_id: `sess-again-${i}`, hook_event_name: 'SessionStart', transcript_path: transcript(`sess-again-${i}`, 'r'), cwd: '/work/repo' }, { helpers: 'run', fetch: spy.fetch });
    expect(spy.requests.filter((r) => r.path === '/tokens/refresh').length).toBe(dials);
  });

  /** A fetch that answers the first `times` transcript segment events with a refusal of `code`, and forwards everything else. */
  const refusingSegments = (rig: MemberRig, code: string, times: number): typeof rig.fetch => {
    let left = times;
    return async (input, init) => {
      const req = new Request(input, init);
      const body = req.method === 'POST' ? await req.clone().text() : '';
      if (left > 0 && new URL(req.url).pathname === '/events' && body.includes('"transcript.segment"')) {
        left -= 1;
        return Response.json({ persisted: false, code, reason: code }, { headers: { 'x-myco-protocol': '1' } });
      }
      return rig.fetch(req);
    };
  };

  it('sends a transcript again after a transient refusal — one clock_skew, then a working Deployment delivers it whole — waiting out the backoff between', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const file = stranded(spool, 'sess-skew');
    const spy = recordingFetch(refusingSegments(rig, 'clock_skew', 1));
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, spy.fetch);
    let t = Date.now();
    const walk = () => drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1', now: () => t });

    expect((await walk()).sessions).toEqual([{ sessionId: 'sess-skew', transcripts: { shipped: 0, endedBy: 'refused' } }]);
    const after = readSessionState(spool.dir, 'sess-skew');
    expect({ refused: after.transcript?.refused, nextOffset: after.transcript?.nextOffset, marked: spool.transcriptBacklogIds() })
      .toEqual({ refused: undefined, nextOffset: 0, marked: ['sess-skew'] });
    expect(after.transcriptRetry?.at).toBeGreaterThan(t);

    const uploads = blobUploads(spy);
    expect((await walk()).sessions).toEqual([{ sessionId: 'sess-skew', transcripts: 'deferred' }]);
    expect(blobUploads(spy)).toBe(uploads);

    t = after.transcriptRetry!.at + 1;
    expect((await walk()).sessions).toEqual([{ sessionId: 'sess-skew', transcripts: { shipped: 1, endedBy: 'done' } }]);
    const delivered = readSessionState(spool.dir, 'sess-skew');
    expect({ nextOffset: delivered.transcript?.nextOffset, retry: delivered.transcriptRetry, marked: spool.transcriptBacklogIds() })
      .toEqual({ nextOffset: fs.statSync(file).size, retry: undefined, marked: [] });
    expect(segmentsOf(rig, 'sess-skew')).toBe(1);
  });

  it('never uploads a transcript refused for good again, not even from its own session\'s turn end', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const tx = transcript('sess-gone', 'refused for good');
    const spy = recordingFetch(refusingSegments(rig, 'session_tombstoned', 1));
    await runHook('stop', { session_id: 'sess-gone', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: spy.fetch });
    expect(readSessionState(spool.dir, 'sess-gone').transcript?.refused).toBe('session_tombstoned');
    const uploads = blobUploads(spy);
    fs.appendFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'later' } })}\n`);
    await runHook('stop', { session_id: 'sess-gone', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { helpers: 'run', fetch: spy.fetch });
    expect(blobUploads(spy)).toBe(uploads);
    expect(segmentsOf(rig, 'sess-gone')).toBe(0);
  });

  it('walks past a session stuck on its own records and leaves it active while delivering later sessions', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const longAgo = Date.now() - 40 * DAY_MS;
    const ctx = (sessionId: string) => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), now: () => longAgo });
    const { sessionStartEvent } = await import('@myco/member/envelope.js');
    for (const id of ['sess-a-stuck', 'sess-b', 'sess-c']) spool.appendAndRecord(id, [sessionStartEvent(ctx(id), { startedAt: longAgo })], undefined, longAgo);
    // A record this build's protocol cannot send: the session is stuck on its own spool.
    const stuckFile = path.join(spool.dir, 'sess-a-stuck.jsonl');
    fs.writeFileSync(stuckFile, fs.readFileSync(stuckFile, 'utf-8').replace('"_memberProtocol":1', '"_memberProtocol":999'));

    const out: string[] = [];
    await runMemberCli(['drain'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: () => {} });

    for (const id of ['sess-b', 'sess-c']) expect(rig.env.sqlite.query('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(id)).toEqual({ n: 1 });
    expect(spool.sessionIds()).toEqual(['sess-a-stuck']);
    expect(fs.existsSync(path.join(spool.dir, 'sess-a-stuck.jsonl'))).toBe(true);
    expect(out.join('\n')).not.toContain('quarantined');
  });

  it('walks the session written to last first when asked, ahead of where the last walk ended', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const ctx = (id: string) => ({ agent: 'copilot', sessionId: id, stage: spool.stagerFor(id), version: 't' });
    // The last walk ended on sess-a, so the next would start with sess-b; sess-a is the one written to last.
    spool.append('sess-b', promptEvent(ctx('sess-b'), { promptId: mintId(), text: 'b' }));
    await new Promise((r) => setTimeout(r, 20));
    spool.append('sess-a', promptEvent(ctx('sess-a'), { promptId: mintId(), text: 'a' }));
    fs.writeFileSync(path.join(spool.dir, '.backlog-cursor'), 'sess-a');
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, rig.fetch);
    const walked = await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1', newestFirst: true });
    expect(walked.sessions.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
  });

  it('starts each walk after the session the last one ended on, so a session that spends the whole budget cannot starve the ones after it', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: SERVER_URL }, { mycoHome });
    const { sessionStartEvent } = await import('@myco/member/envelope.js');
    for (const id of ['sess-a-slow', 'sess-b']) spool.appendAndRecord(id, [sessionStartEvent({ agent: 'claude-code', sessionId: id, stage: spool.stagerFor(id) }, { startedAt: Date.now() })]);
    let t = Date.now();
    // The Deployment answers the first session's events with a re-slice, and the answer takes the rest of the budget.
    const slow: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      const body = req.method === 'POST' ? await req.clone().text() : '';
      if (new URL(req.url).pathname === '/events' && body.includes('"sess-a-slow"')) {
        t += 60 * 60 * 1000;
        return Response.json({ persisted: false, code: 'offset_gap', reason: 'gap', transcript: { size: 0 } }, { headers: { 'x-myco-protocol': '1' } });
      }
      return rig.fetch(req);
    };
    const client = new ServerClient({ serverUrl: SERVER_URL, token: rig.token, projectId: PROJECT }, slow);
    const walk = () => drainBacklog(spool, client, { ...unboundedBudget(), deadline: t + 60_000 }, { force: true, machineId: 'machine_1', now: () => t });

    expect((await walk()).sessions.map((x) => x.sessionId)).toEqual(['sess-a-slow']);
    expect((await walk()).sessions.map((x) => x.sessionId)).toEqual(['sess-b', 'sess-a-slow']);
    expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-b'`).get()).toEqual({ n: 1 });
  });
});
