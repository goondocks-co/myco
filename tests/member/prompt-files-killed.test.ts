import { afterEach, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember, runHook } from './helpers/hooks.js';

const PROJECT = 'proj_1';
const SESSION = 'sess-killed-prompt';
const CLI = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'entries', 'cli.ts');
const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.skipIf(process.platform === 'win32')('keeps file openings out of persisted recall when its helper is killed during the request', async () => {
  const mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  const rig = await memberRig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-killed-prompt-'));
  const opening = 'PROSE_OPENING_ONLY_FOR_SELECTION';
  fs.writeFileSync(path.join(root, 'task.md'), opening);
  const prompt = 'Read task.md and repair capture.';
  let notify = () => {};
  let release = () => {};
  const arrived = new Promise<void>(resolve => { notify = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/context/prompt') return rig.fetch(request);
    sent = (await request.json() as { text: string }).text;
    notify();
    await held;
    return Response.json({ persisted: true, context: '', skipped: [] });
  } });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const serverUrl = `http://127.0.0.1:${server.port}`;
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, root, serverUrl });
    const tx = path.join(root, 'session.jsonl');
    fs.writeFileSync(tx, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    const common = { session_id: SESSION, cwd: root, transcript_path: tx };
    await runHook('session-start', common, { fetch, helpers: 'run' });
    await runHook('user-prompt-submit', { ...common, prompt }, { fetch, helpers: 'record' });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl }, { mycoHome });
    const recall = readSessionState(spool.dir, SESSION).promptRecall!;
    expect(recall).toBeDefined();
    expect(recall.asks[recall.current]?.request.text).toBe(prompt);
    child = spawn(process.execPath, [CLI, 'member', 'helper', '--project', PROJECT, '--server', serverUrl, '--home', mycoHome], { cwd: root, env: { ...process.env, MYCO_HOME: mycoHome }, stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child!.on('exit', () => resolve()));
    expect(await Promise.race([arrived.then(() => true), sleep(60_000).then(() => false)])).toBe(true);
    expect(sent.startsWith(prompt)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    release();
    await runHook('stop', common, { fetch, helpers: 'record' });
    await runHook('session-end', common, { fetch, helpers: 'record' });
    expect(JSON.stringify(readSessionState(spool.dir, SESSION))).not.toContain(opening);
  } finally {
    child?.kill('SIGKILL'); release(); server.stop(true); rig.env.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

