/**
 * A member that could not deliver for a while — offline past its token's TTL,
 * or holding a credential the Deployment refuses — through the real hooks and
 * the in-process worker.
 *
 * A lapsed token of a live lineage renews on the first hook back and that hook
 * delivers on it. A refusal that is final is recorded and said, on stderr and in
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
import { issueMemberToken, MEMBER_TOKEN_MAX_LINEAGE_MS } from '@myco-server-worker/auth/tokens.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { run as runMemberCli } from '@myco/cli/member.js';
import { agentOfSession, drainBacklog } from '@myco/member/backlog.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { recordJoinAnswer } from '@myco/member/join-code.js';
import { refreshDue } from '@myco/member/refresh.js';
import { readRegistryEntry } from '@myco/member/registry.js';
import { emptySessionState, readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { ServerClient } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const NOT_DELIVERED = 'capture is not being delivered';

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
  const start = await runHook('session-start', { session_id: sessionId, hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { fetch: fetchImpl });
  const stop = await runHook('stop', { session_id: sessionId, hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: `re: ${text}` }, { fetch: fetchImpl });
  const end = await runHook('session-end', { session_id: sessionId, hook_event_name: 'SessionEnd', transcript_path: tx }, { fetch: fetchImpl });
  return { tx, start, stop, end };
}

async function parseAll(rig: MemberRig): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) if ((await parseTranscripts(rig.env.serverEnv, Date.now())) === 0) return;
}

const prompts = (rig: MemberRig): string[] =>
  (rig.env.sqlite.query('SELECT text FROM prompt_batches ORDER BY text').all() as Array<{ text: string }>).map((r) => r.text);
const segmentsOf = (rig: MemberRig, sessionId: string): number =>
  (rig.env.sqlite.query('SELECT COUNT(*) AS n FROM transcript_segments s JOIN transcripts t ON t.transcript_id = s.transcript_id WHERE t.session_id = ?').get(sessionId) as { n: number }).n;
const revoke = (rig: MemberRig, tokenId: string): void => { rig.env.sqlite.query('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), tokenId); };

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
    expect(new MemberSpool(PROJECT, { mycoHome }).sessionIds()).toEqual([]);
  });

  it('says so at the point of use once the lineage has ended, and keeps what it captures', async () => {
    const rig = await memberRig({ now: Date.now() - MEMBER_TOKEN_MAX_LINEAGE_MS - DAY_MS });
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    const tx = transcript('sess-ended', 'nobody hears this');
    const start = await runHook('session-start', { session_id: 'sess-ended', hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { fetch: spy.fetch });

    expect(readRegistryEntry(root, mycoHome)!.refreshTerminal).toBe(true);
    expect(start.stderr).toContain(NOT_DELIVERED);
    expect(start.stderr).toContain('myco login <link>');
    expect(start.stdout).toContain(NOT_DELIVERED);
    expect(rig.rows('member_credentials')).toBe(1);
    expect(rig.rows('sessions')).toBe(0);
    expect(new MemberSpool(PROJECT, { mycoHome }).depth('sess-ended')).toBe(1);

    // Terminal: a later hook asks the refresh route nothing, and still says so.
    const refreshes = spy.requests.filter((r) => r.path === '/tokens/refresh').length;
    const stop = await runHook('stop', { session_id: 'sess-ended', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { fetch: spy.fetch });
    expect(spy.requests.filter((r) => r.path === '/tokens/refresh').length).toBe(refreshes);
    expect(stop.stderr).toContain(NOT_DELIVERED);
  });

  it('delivers a session captured while refused — events and turn-end transcript — from the next session\'s turn end after a re-login, after that session\'s own delivery, once', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    revoke(rig, rig.tokenId);
    const spy = recordingFetch(rig.fetch);

    const refused = await session(spy.fetch, 'sess-refused', 'captured while refused');
    expect(refused.start.stderr).toContain(NOT_DELIVERED);
    expect(rig.rows('sessions')).toBe(0);
    expect(readRegistryEntry(root, mycoHome)!.refreshTerminal).toBe(true);
    const spool = new MemberSpool(PROJECT, { mycoHome });
    expect(spool.depth('sess-refused')).toBe(2);
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

    // The turn end delivers its own session before any of the backlog.
    const order = (rig.env.sqlite.query(`SELECT session_id AS s, kind AS k FROM events WHERE producer_adapter <> 'transcript-parse' ORDER BY received_at, rowid`).all() as Array<{ s: string; k: string }>)
      .map((r) => `${r.s} ${r.k}`);
    expect(order.slice(0, 2)).toEqual(['sess-next session.start', 'sess-next transcript.segment']);
    expect(order.slice(2, 5)).toEqual(['sess-refused session.start', 'sess-refused session.end', 'sess-refused transcript.segment']);
    expect(spy.requests.slice(seen).every((r) => r.path !== '/tokens/refresh')).toBe(true);

    expect(segmentsOf(rig, 'sess-refused')).toBe(1);
    expect(spool.sessionIds()).toEqual([]);
    expect(spool.transcriptBacklogIds()).toEqual([]);
    await parseAll(rig);
    expect(prompts(rig)).toEqual(['captured while refused', 'first turn after re-login']);

    // Nothing is delivered twice: another turn end, and an explicit drain, add no row.
    const counts = () => ['events', 'transcript_segments', 'prompt_batches', 'responses'].map((t) => rig.rows(t));
    const before = counts();
    await runHook('stop', { session_id: 'sess-next', hook_event_name: 'Stop', transcript_path: next.tx, last_assistant_message: 'x' }, { fetch: spy.fetch });
    await runMemberCli(['drain'], { mycoHome, fetch: spy.fetch, stdout: () => {}, stderr: () => {} });
    await parseAll(rig);
    expect(counts()).toEqual(before);
  });

  it('gives the backlog only what the owning session leaves of the turn end\'s budget', async () => {
    const rig = await memberRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spool = new MemberSpool(PROJECT, { mycoHome });
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
    await runHook('stop', { session_id: 'sess-busy', hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'x' }, { fetch: spy.fetch, now: () => t });

    expect(segmentsOf(rig, 'sess-busy')).toBe(1);
    expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-waiting'`).get()).toEqual({ n: 0 });
    expect(spool.depth('sess-waiting')).toBe(2);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-waiting']);
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
      const spool = new MemberSpool(PROJECT, { mycoHome });
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
    } finally {
      if (savedUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedUserHome;
    }
  });
});
