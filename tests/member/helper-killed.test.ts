/**
 * Gate G4b (#1561 PR 3a): a helper killed part-way through a request loses nothing and duplicates nothing.
 *
 * A real `myco member helper` process ships a session over loopback to a test Deployment. When the request named by
 * the case arrives (an event, a blob upload, or a transcript segment), the helper is killed with SIGKILL while the
 * Deployment still holds the request; the Deployment then applies it anyway, as a server does when its client dies
 * after sending. The operating system releases the helper's lock, and the next helper finishes the work: every
 * event is held once, and the transcript's segments meet end to end and cover the file, none sent twice over. POSIX only: the Windows
 * start is covered by `tests/runtime/spawn-detached.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { mintId, promptEvent, sessionStartEvent } from '@myco/member/envelope.js';
import { MEMBER_INLINE_TEXT_MAX_BYTES } from '@myco/member/constants.js';
import { helperPaths } from '@myco/member/helper.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { memberRig, TEST_MACHINE_ID, tempMycoHome } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

const PROJECT = 'proj_1';
const SESSION = 'sess-killed';
const CLI = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'entries', 'cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

type KillAt = 'event' | 'blob' | 'segment';

/** What a request to the Deployment carries: a blob upload, a transcript segment, another event, or neither. */
async function requestKind(req: Request): Promise<KillAt | null> {
  const { pathname } = new URL(req.url);
  if (req.method !== 'POST') return null;
  if (pathname.startsWith('/blobs/')) return 'blob';
  if (pathname !== '/events') return null;
  const body = JSON.parse(await req.clone().text()) as { kind?: string };
  return body.kind === 'transcript.segment' ? 'segment' : 'event';
}

describe.skipIf(process.platform === 'win32')('a helper killed mid-request (G4b)', () => {
  for (const at of ['event', 'blob', 'segment'] as const) {
    it(`lets go of its lock, and the next helper delivers everything once, when killed mid-${at}`, async () => {
      const rig = await memberRig();
      let arrived: () => void = () => {};
      const stalled = new Promise<void>((resolve) => { arrived = resolve; });
      let seen = 0;
      let killing = true;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          if (killing && (await requestKind(req)) === at && ++seen === (at === 'segment' ? 1 : 2)) {
            arrived();
            // Held until the helper is dead, then applied: the client never reads the answer.
            await sleep(1_000);
          }
          return rig.fetch(req);
        },
      });
      try {
        registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: `http://127.0.0.1:${server.port}` });
        const spool = new MemberSpool(PROJECT, { mycoHome });
        const ctx = { agent: 'claude-code', sessionId: SESSION, stage: spool.stagerFor(SESSION), version: 't' };
        spool.append(SESSION, sessionStartEvent(ctx, { branch: 'main', startedAt: Date.now(), originPath: '/work' }));
        // Prompts, every third one too long to travel inline, so it uploads its bytes first.
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
          const text = i % 3 === 2 ? `${i} ${'x'.repeat(MEMBER_INLINE_TEXT_MAX_BYTES + 10)}` : `prompt ${i}`;
          const event = promptEvent(ctx, { promptId: mintId(), text });
          ids.push(event.envelope.eventId);
          spool.append(SESSION, event);
        }
        // A transcript behind, not yet shipped.
        const tx = path.join(fs.mkdtempSync(path.join('/tmp', 'myco-killed-tx-')), `${SESSION}.jsonl`);
        const line = (i: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i} ${'y'.repeat(4_000)}` } });
        fs.writeFileSync(tx, Array.from({ length: 600 }, (_, i) => line(i)).join('\n') + '\n');
        updateSessionState(spool.dir, SESSION, (s) => { s.transcript = transcriptPointerFor(tx, TEST_MACHINE_ID)!; s.agent = 'claude-code'; });
        spool.markTranscriptBacklog(SESSION);

        // Under /tmp: a macOS per-user $TMPDIR can make every process started in it slow to launch.
        const cwd = fs.mkdtempSync(path.join('/tmp', 'myco-killed-cwd-'));
        const child = spawn(process.execPath, [CLI, 'member', 'helper', '--project', PROJECT, '--home', mycoHome], {
          cwd, env: { ...process.env, MYCO_HOME: mycoHome }, stdio: 'ignore',
        });
        const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
        const timedOut = sleep(60_000).then(() => 'timeout' as const);
        expect(await Promise.race([stalled.then(() => 'stalled' as const), timedOut])).toBe('stalled');
        child.kill('SIGKILL');
        await exited;
        await sleep(1_200);
        killing = false;

        // The operating system let go of the dead helper's lock.
        const lock = LifecycleLock.acquire(helperPaths(PROJECT, mycoHome).lock);
        expect(lock.acquired).toBe(true);
        if (lock.acquired) lock.lock.release();

        // The next helper finishes the work.
        const result = await runHelperVerb(['--project', PROJECT, '--home', mycoHome], { lingerMs: 0, keepStderr: true });
        expect(result?.endedBy).toBe('idle');
        const held = rig.env.sqlite.query(`SELECT event_id FROM events WHERE session_id = ? AND kind = 'prompt'`).all(SESSION) as Array<{ event_id: string }>;
        expect(held.map((r) => r.event_id).sort()).toEqual([...ids].sort());
        const segments = rig.env.sqlite.query('SELECT base_offset, length FROM transcript_segments ORDER BY base_offset').all() as Array<{ base_offset: number; length: number }>;
        expect(segments.length).toBeGreaterThan(0);
        let next = 0;
        for (const segment of segments) {
          expect(segment.base_offset).toBe(next);
          next += segment.length;
        }
        expect(next).toBe(fs.statSync(tx).size);
        expect(fs.existsSync(path.join(spool.dir, `${SESSION}.jsonl`))).toBe(false);
        fs.rmSync(path.dirname(tx), { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      } finally {
        server.stop(true);
      }
    }, 120_000);
  }
});
