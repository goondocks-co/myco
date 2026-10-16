import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/setup.js';
import { readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { deploymentPath, writeDeploymentMembership } from '@myco/member/registry.js';
import { defaultDeploymentPath, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { runnerRecordPath, newRunnerBearer } from '@myco/runner/runner-registry.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';

const FIRST = 'https://first.invalid';
const SECOND = 'https://second.invalid';
let scratch: string;
let home: string;
let lines: string[];
let errors: string[];
let questions: string[];
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-inference-'));
  home = path.join(scratch, 'myco');
  lines = []; errors = []; questions = [];
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });
const membership = (serverUrl: string) => writeDeploymentMembership({ serverUrl, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
const deps = () => ({
  mycoHome: home, cwd: scratch, agents: () => [],
  stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line),
  ask: async (question: string) => { questions.push(question); throw new Error(`Unexpected prompt: ${question}`); },
  fetch: Object.assign(async () => { throw new Error('fixture offline'); }, { preconnect: () => {} }),
});

it('resumes one membership without a setup file or role question', async () => {
  membership(FIRST);
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: FIRST });
  expect(lines).toContain(`This machine joins ${FIRST}; continuing.`);
  expect(errors.join('\n')).toContain('Deployment unreachable');
});

for (const joined of [false, true]) it(`does not consult a damaged default with ${joined ? 'one' : 'no'} observed journey`, async () => {
  if (joined) membership(FIRST);
  const file = defaultDeploymentPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{', { mode: 0o600 });
  expect(await run([], { ...deps(), ask: async question => { questions.push(question); return null; } })).toBe(2);
  if (joined) {
    expect(questions).toEqual([]);
    expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: FIRST });
    expect(lines).toContain(`This machine joins ${FIRST}; continuing.`);
  } else expect(questions[0]).toContain('What should this machine do?');
});

it('chooses and names the default among two memberships', async () => {
  membership(FIRST); membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home });
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: SECOND });
  expect(lines).toContain(`This machine joins ${SECOND}; continuing.`);
});

it('asks which observed Deployment when neither membership is default', async () => {
  membership(FIRST); membership(SECOND);
  expect(await run([], { ...deps(), ask: async question => {
    questions.push(question);
    expect(question).not.toContain('What should this machine do?');
    expect(question).toContain(FIRST);
    expect(question).toContain(SECOND);
    expect(question).toContain('Something else');
    return '2';
  } })).toBe(2);
  expect(questions).toHaveLength(1);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: SECOND });
});

for (const mode of ['empty', 'change', 'something else'] as const) it(`asks the role for ${mode}`, async () => {
  if (mode !== 'empty') membership(FIRST);
  if (mode === 'change') saveSetupFile(home, { version: 1, answers: { role: 'join', url: FIRST }, consented: {} });
  if (mode === 'something else') membership(SECOND);
  expect(await run(mode === 'change' ? ['--change'] : [], { ...deps(), ask: async question => {
    questions.push(question);
    return question.includes('Something else') ? '3' : null;
  } })).toBe(2);
  expect(questions.at(-1)).toContain('What should this machine do?');
  expect(questions).toHaveLength(mode === 'something else' ? 2 : 1);
});

it('refuses an unreadable membership by file before any prompt or saved answer', async () => {
  membership(FIRST); membership(SECOND);
  const file = deploymentPath(SECOND, home);
  fs.writeFileSync(file, '{', { mode: 0o600 });
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(errors.join('\n')).toContain(file);
  expect(fs.existsSync(setupFilePath(home))).toBe(false);
  lines = [];
  expect(await run(['--status'], deps())).toBe(4);
  expect(lines.join('\n')).toContain(file);
});

for (const change of [false, true]) it(`keeps an explicit join ahead of inferred membership${change ? ' with --change' : ''}`, async () => {
  membership(FIRST);
  expect(await run([...(change ? ['--change'] : []), '--join', SECOND], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: SECOND });
  expect(lines.join('\n')).not.toContain('continuing.');
});

it('asks for device approval when the inferred membership credential is refused', async () => {
  membership(FIRST);
  let logins = 0;
  expect(await run([], { ...deps(), login: async () => { logins++; return false; }, ask: async question => {
    questions.push(question);
    expect(question).toContain('Approve this plan?');
    return 'no';
  }, fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const route = new URL(new Request(input).url).pathname;
    if (route === '/health') return Response.json({ ok: true });
    if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(`${FIRST}/auth/callback`)}` } });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }, { preconnect: () => {} }) })).toBe(2);
  expect(questions).toHaveLength(1);
  expect(lines.join('\n')).toContain('Sign this machine in through device approval?');
  expect(logins).toBe(0);
  expect(errors.join('\n')).toContain('Plan declined');
});

it('infers a runner-only machine without asking the member role question', async () => {
  const file = runnerRecordPath(FIRST, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, serverUrl: FIRST, token: newRunnerBearer(), runnerId: 'rn_inferred', deploymentId: 'fixture', name: 'Fixture runner' }), { mode: 0o600 });
  expect(await run([], { ...deps(), worker: { home: scratch, harnessDirs: () => [], runner: () => { throw new Error('fixture service unavailable'); } } })).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'runner', url: FIRST });
  expect(lines).toContain(`This machine runs Myco’s work for ${FIRST}; continuing.`);
});

for (const target of ['local', 'cloudflare'] as const) it(`infers a ${target} creation without asking the member role question`, async () => {
  if (target === 'local') createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
  else writeDeploymentRecord({ accountId: 'a'.repeat(32), workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: new Date(0).toISOString(), url: FIRST }, home);
  expect(await run([], { ...deps(), local: { native: { library: null, vec0: null }, service: { runner: () => { throw new Error('fixture service unavailable'); } } },
    cloudflare: { runner: { run: async () => { throw new Error('fixture operator unavailable'); } } },
    ask: async question => { questions.push(question); throw new Error(`Stopped at creation choice: ${question}`); },
  })).toBe(2);
  expect(questions.join('\n')).not.toContain('What should this machine do?');
  expect(readSetupFile(home).answers).toMatchObject({ role: 'create', target, url: target === 'local' ? 'http://127.0.0.1:8787' : FIRST });
  expect(lines.join('\n')).toContain('This machine starts Myco');
});
