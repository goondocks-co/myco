/**
 * Delivery when no helper can outlive the hook, and journals across builds (#1561 PR 3b).
 *
 * - G4g, sandbox: a credential from the environment never starts a helper. Its prompt hook makes no request; its
 *   turn's end (`--ship inline`) delivers everything in the hook.
 * - The same for any hook told to ship inline, and for a helper started inside the caller's Job Object (`contained`):
 *   the turn's end delivers in-process, and nothing waits on a helper that ends with the hook.
 * - G4h, upgrade directions: a journal this build writes holds only events an older build can read (its protocol
 *   stamp on every line, turn-end marks kept apart), and a journal an older build wrote delivers whole here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { MEMBER_PROTOCOL } from '@myco/member/constants.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { ServerClient } from './helpers/env-client.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { helperPaths, runHelper } from '@myco/member/helper.js';
import { helperPass } from '@myco/member/helper-pass.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
const savedHome = process.env.MYCO_HOME;
const savedEnv = { ...process.env };
beforeEach(async () => {
  mycoHome = tempMycoHome();
  scratch.push(mycoHome);
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
});
/** Directories a test made, removed after it. */
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_JOIN_CODE]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

const transcript = (id: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-inline-tx-'));
  scratch.push(dir);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  return file;
};
/** A start that must never happen. */
const noStart: DetachedSpawn = () => { throw new Error('no helper may be started here'); };
const spool = () => new MemberSpool({ projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid' }, { mycoHome });

describe('a sandbox (G4g)', () => {
  it('captures from the environment\'s credential without a request, and delivers everything at the turn\'s end, in the hook', async () => {
    process.env[ENV_SERVER_URL] = 'https://sandbox.test';
    process.env[ENV_MEMBER_TOKEN] = rig.token;
    process.env[ENV_PROJECT] = 'proj_1';
    const spy = recordingFetch(rig.fetch);
    const tx = transcript('sess-sandbox');
    const start = await runHook('session-start', { session_id: 'sess-sandbox', transcript_path: tx, cwd: process.cwd() }, { fetch: spy.fetch, credential: 'env', symbiont: 'copilot', helperSpawn: noStart });
    const prompt = await runHook('user-prompt-submit', { session_id: 'sess-sandbox', prompt: 'in the sandbox', transcript_path: tx }, { fetch: spy.fetch, credential: 'env', symbiont: 'copilot', helperSpawn: noStart });
    expect(spy.requests).toEqual([]);
    // No start was tried: a tried start is logged as one the caller ships inline.
    for (const hook of [start, prompt]) expect(hook.stderr).not.toContain('could not start a helper');
    expect(fs.existsSync(path.join(mycoHome, 'logs', 'helper.log'))).toBe(false);
    expect(spool().depth('sess-sandbox')).toBeGreaterThan(0);

    await runHook('stop', { session_id: 'sess-sandbox', last_assistant_message: 'done', transcript_path: tx }, { fetch: spy.fetch, credential: 'env', symbiont: 'copilot', argv: ['--ship', 'inline'], helperSpawn: noStart });
    // The capture first, then the context the prompt asked for: the sandbox may end with this hook.
    const paths = spy.requests.map((r) => r.path);
    expect(paths.indexOf('/events')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/context/prompt')).toBeGreaterThan(paths.indexOf('/events'));
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(rig.rows('responses')).toBe(1);
    expect(spool().depth('sess-sandbox')).toBe(0);
  });
});

describe('a sandbox holding only a join code (G4g)', () => {
  it('redeems the code on its first hook, starts no helper, and delivers everything at the turn\'s end, in the hook', async () => {
    // The emitted sandbox settings declare `env`; the redeemed membership resolves from the registry all the same.
    for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT]) delete process.env[key];
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const spy = recordingFetch(rig.fetch);
    const tx = transcript('sess-code');
    const opts = { fetch: spy.fetch, credential: 'env' as const, symbiont: 'copilot', helperSpawn: noStart };
    const start = await runHook('session-start', { session_id: 'sess-code', transcript_path: tx, cwd: process.cwd() }, opts);
    const prompt = await runHook('user-prompt-submit', { session_id: 'sess-code', prompt: 'in the sandbox', transcript_path: tx }, opts);
    // The first hook's exchange, and the Project's blocks previewed for the cache with it; nothing after it until the
    // turn's end.
    expect(spy.requests.map((r) => r.path)).toEqual(['/members/join', '/context/session', '/context/session']);
    for (const hook of [start, prompt]) expect(hook.stderr).not.toContain('could not start a helper');
    expect(rig.rows('prompt_batches')).toBe(0);

    await runHook('stop', { session_id: 'sess-code', last_assistant_message: 'done', transcript_path: tx }, opts);
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(rig.rows('responses')).toBe(1);
    expect(spool().depth('sess-code')).toBe(0);
  });
});

describe('a turn\'s end that ships inline', () => {
  beforeEach(() => {
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
  });

  it('delivers in the hook when its command says --ship inline, and starts no helper', async () => {
    const tx = transcript('sess-flag');
    const offline = recordingFetch(async () => { throw new TypeError('fetch failed'); });
    // The capture before the turn's end is only spooled (its helper could not reach the Deployment).
    await runHook('user-prompt-submit', { session_id: 'sess-flag', prompt: 'spooled', transcript_path: tx }, { fetch: offline.fetch, symbiont: 'copilot' });
    expect(spool().depth('sess-flag')).toBe(1);
    await runHook('stop', { session_id: 'sess-flag', last_assistant_message: 'done', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', argv: ['--ship', 'inline'], helperSpawn: noStart });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(spool().depth('sess-flag')).toBe(0);
  });

  it('delivers in the hook when the helper it started is held in the caller\'s Job Object, or could not be started', async () => {
    for (const [sessionId, start] of [
      ['sess-contained', () => ({ started: true, pid: process.pid, contained: true })],
      ['sess-failed', () => ({ started: false })],
    ] as Array<[string, DetachedSpawn]>) {
      const tx = transcript(sessionId);
      // The helper this start stands for never runs: it ends with the hook, or never began.
      await runHook('stop', { session_id: sessionId, last_assistant_message: `done ${sessionId}`, transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: start });
      expect({ sessionId, depth: spool().depth(sessionId) }).toEqual({ sessionId, depth: 0 });
    }
    expect(rig.rows('responses')).toBe(2);
  });

  it('waits on a helper the harness\'s job holds, which cleared the marks as its pass began, until the turn is delivered', async () => {
    const tx = transcript('sess-held');
    // The capture hooks of the turn: their helper was started inside the harness's Job Object.
    await runHook('user-prompt-submit', { session_id: 'sess-held', prompt: 'held', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: () => ({ started: true, pid: process.pid, contained: true }) });
    expect(spool().depth('sess-held')).toBe(1);
    // That helper takes the lock, clears the marks, and delivers only after a while.
    let passStarted = false;
    const deliver = helperPass({ projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid' }, mycoHome, { fetch: rig.fetch });
    const holder = runHelper({
      projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid', mycoHome, contained: true, lingerMs: 0,
      pass: async (deadline, o) => { passStarted = true; await Bun.sleep(400); return deliver(deadline, o); },
    });
    while (!passStarted) await Bun.sleep(5);
    expect(fs.existsSync(helperPaths('proj_1', mycoHome, 'https://s').dirty)).toBe(false);
    // The turn's end finds that helper holding the work, and ships inline: it waits for it, never past its budget.
    await runHook('stop', { session_id: 'sess-held', last_assistant_message: 'done', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: noStart });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(spool().depth('sess-held')).toBe(0);
    await holder;
  });

  it('waits only for what the turn\'s end appended: a transcript of the session waiting out a refusal holds it no longer', async () => {
    const tx = transcript('sess-own');
    await runHook('user-prompt-submit', { session_id: 'sess-own', prompt: 'own', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: () => ({ started: true, pid: process.pid, contained: true }) });
    // The Deployment takes `turn`: the turn's end is a record of its own, not a mark on the transcript.
    updateProjectContext(spool().dir, mycoHome, (cache) => { cache.features = ['turn']; });
    // The session's transcripts wait out a refusal for ten minutes: the session as a whole is not delivered before then.
    updateSessionState(spool().dir, 'sess-own', (state) => { state.transcriptRetry = { at: Date.now() + 600_000, backoffMs: 600_000 }; });
    // A helper the harness's job holds takes the lock and keeps it for eight seconds, delivering as it goes.
    let passStarted = false;
    const deliver = helperPass({ projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid' }, mycoHome, { fetch: rig.fetch });
    const holder = runHelper({
      projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid', mycoHome, contained: true, lingerMs: 8_000, deadlineMs: 8_000,
      pass: async (deadline, o) => { passStarted = true; await Bun.sleep(300); return deliver(deadline, o); },
    });
    while (!passStarted) await Bun.sleep(5);
    const started = Date.now();
    await runHook('stop', { session_id: 'sess-own', last_assistant_message: 'own reply', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: noStart });
    // Back once its own records are delivered, not when the helper lets go or the session's transcript ships.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(rig.rows('responses')).toBe(1);
    expect(spool().pendingTurnEnds('sess-own')).toEqual([]);
    expect(fs.statSync(tx).size).toBeGreaterThan(readSessionState(spool().dir, 'sess-own').transcript?.nextOffset ?? 0);
    await holder;
  }, 20_000);

  it('waits for its turn\'s own transcript as well as its records, the transcript slower to arrive than they are', async () => {
    const tx = transcript('sess-tx');
    await runHook('user-prompt-submit', { session_id: 'sess-tx', prompt: 'tx', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: () => ({ started: true, pid: process.pid, contained: true }) });
    updateProjectContext(spool().dir, mycoHome, (cache) => { cache.features = ['turn']; });
    // The Deployment takes records at once and a transcript's bytes 700 ms late.
    const slowBlobs: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname.startsWith('/blobs/')) await Bun.sleep(700);
      return rig.fetch(req);
    };
    let passStarted = false;
    const deliver = helperPass({ projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid' }, mycoHome, { fetch: slowBlobs });
    const holder = runHelper({
      projectId: 'proj_1', serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid', mycoHome, contained: true, lingerMs: 3_000, deadlineMs: 6_000,
      pass: async (deadline, o) => { passStarted = true; await Bun.sleep(200); return deliver(deadline, o); },
    });
    while (!passStarted) await Bun.sleep(5);
    await runHook('stop', { session_id: 'sess-tx', last_assistant_message: 'tx reply', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: noStart });
    expect(rig.rows('responses')).toBe(1);
    expect(readSessionState(spool().dir, 'sess-tx').transcript?.nextOffset).toBe(fs.statSync(tx).size);
    await holder;
  }, 20_000);

  it('leaves an ordinary hook\'s capture to the helper even when no helper could be started', async () => {
    const tx = transcript('sess-capture');
    await runHook('user-prompt-submit', { session_id: 'sess-capture', prompt: 'later', transcript_path: tx }, { fetch: rig.fetch, symbiont: 'copilot', helperSpawn: () => ({ started: false }) });
    expect(rig.rows('prompt_batches')).toBe(0);
    expect(spool().depth('sess-capture')).toBe(1);
  });
});

describe('a journal across builds (G4h)', () => {
  beforeEach(() => {
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
  });

  it('this build writes only lines an older build reads as events, and keeps turn-end marks out of the journal', async () => {
    const offline = async () => { throw new TypeError('fetch failed'); };
    const tx = transcript('sess-new');
    await runHook('session-start', { session_id: 'sess-new', transcript_path: tx, cwd: process.cwd() }, { fetch: offline, symbiont: 'copilot' });
    await runHook('user-prompt-submit', { session_id: 'sess-new', prompt: 'p', transcript_path: tx }, { fetch: offline, symbiont: 'copilot' });
    await runHook('stop', { session_id: 'sess-new', last_assistant_message: 'r', transcript_path: tx }, { fetch: offline, symbiont: 'copilot' });
    const raw = fs.readFileSync(path.join(spool().dir, 'sess-new.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(raw.length).toBeGreaterThan(2);
    // An older build stops at a line without its protocol stamp: every line has one, and none is a mark.
    expect(raw.filter((line) => line._memberProtocol !== MEMBER_PROTOCOL || line.t !== undefined)).toEqual([]);
  });

  it('delivers whole a journal an older build wrote: no journal stamp, the same protocol', async () => {
    const s = spool();
    const ctx = { agent: 'copilot', sessionId: 'sess-old', stage: s.stagerFor('sess-old'), version: '1.9.0' };
    const lines = ['one', 'two'].map((text) => {
      const { envelope } = promptEvent(ctx, { promptId: mintId(), text });
      return JSON.stringify({ ...envelope, _memberProtocol: MEMBER_PROTOCOL, timestamp: new Date().toISOString() });
    });
    fs.mkdirSync(s.dir, { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'sess-old.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const drained = await s.drainSession('sess-old', new ServerClient({ serverUrl: process.env[ENV_SERVER_URL] ?? 'https://member-test.invalid', token: rig.token, projectId: 'proj_1' }, rig.fetch), unboundedBudget());
    expect(drained).toMatchObject({ acked: 2, endedBy: 'drained' });
    expect(fs.existsSync(path.join(s.dir, 'sess-old.jsonl'))).toBe(false);
  });
});
