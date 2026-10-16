import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSetupOptions, run } from '@myco/cli/setup.js';
import { applyObservedSetupJourney, applyObservedSetupRunWork, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { deploymentPath, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { defaultDeploymentPath, readDefaultDeployment, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { runnerRecordPath, newRunnerBearer } from '@myco/runner/runner-registry.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';
import { observeSetupJourneys, observeSetupRunWork, observeSetupStatus } from '@myco/setup/observe.js';
import type { SetupDeps } from '@myco/setup/steps.js';

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
  expect(readSetupFile(home).answers.role).toBeUndefined();
  expect(readSetupFile(home).answers.url).toBeUndefined();
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
    expect(readSetupFile(home).answers.role).toBeUndefined();
    expect(lines).toContain(`This machine joins ${FIRST}; continuing.`);
  } else expect(questions[0]).toContain('What should this machine do?');
});

it('chooses and names the default among two memberships', async () => {
  membership(FIRST); membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home });
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers.role).toBeUndefined();
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
  questions = []; lines = [];
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(lines.join('\n')).not.toContain('continuing.');
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
  recordDefaultDeployment(FIRST, { mycoHome: home });
  expect(await run([...(change ? ['--change'] : []), '--join', SECOND], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: SECOND });
  expect(lines.join('\n')).not.toContain('continuing.');
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: SECOND });
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
  expect(readSetupFile(home).answers.role).toBeUndefined();
  expect(readSetupFile(home).answers.url).toBeUndefined();
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
  expect(readSetupFile(home).answers.role).toBeUndefined();
  expect(readSetupFile(home).answers.url).toBeUndefined();
  expect(readSetupFile(home).answers.target).toBeUndefined();
  expect(lines.join('\n')).toContain('This machine starts Myco');
});

const runnerRecord = (serverUrl: string) => {
  const file = runnerRecordPath(serverUrl, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, serverUrl, token: newRunnerBearer(), runnerId: 'rn_choices', deploymentId: 'fixture', name: 'Fixture runner' }), { mode: 0o600 });
  return file;
};
const online = (calls: string[] = []): typeof fetch => Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(new Request(input).url);
  calls.push(url.origin);
  if (url.pathname === '/health') return Response.json({ ok: true });
  if (url.pathname === '/auth/login') return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(`${url.origin}/auth/callback`)}` } });
  if (url.pathname === '/members/status') return Response.json({ ok: true });
  return Response.json({ error: 'not_found' }, { status: 404 });
}, { preconnect: () => {} });

const readyJoin = (): SetupDeps => {
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  const fetch = online();
  return { ...deps(), cwd: root,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(new Request(input, init).url).pathname === '/runners/contact') return Response.json({ persisted: true,
        runner: { id: 'rn_choices', name: 'Fixture runner', deploymentId: 'fixture', state: 'enabled' },
        credential: { id: 'fixture', expiresAt: 9999999999999, refreshAfter: 0 } });
      return fetch(input, init);
    }, { preconnect: () => {} }),
    worker: { home: scratch, lockDir: path.join(scratch, 'locks'), harnessDirs: () => [], runner: () => ({ status: 113 }) },
    join: async args => {
      const entry = { version: 2 as const, root: args[args.indexOf('--root') + 1]!, projectId: 'proj_ready', serverUrl: args[0]!, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 };
      writeRegistryEntry(entry, { mycoHome: home });
      return entry;
    },
  };
};

it('re-infers after leaving the observed Deployment without signing back in or retaining a stale status journey', async () => {
  membership(FIRST);
  expect(await run([], deps())).toBe(2);
  fs.rmSync(deploymentPath(FIRST, home));
  membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home, replace: true });
  const logins: string[][] = [];
  const calls: string[] = [];
  lines = []; errors = [];
  expect(await run(['--cutover', '--yes', '--no-agents', '--no-runner'], { ...deps(), fetch: online(calls),
    login: async args => { logins.push([...args]); return false; }, join: async () => null,
  })).toBe(2);
  expect(logins).toEqual([]);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(url => url === SECOND)).toBe(true);
  expect(readSetupFile(home).answers).toMatchObject({ cutover: true, noAgents: true, runWork: false });
  expect(readSetupFile(home).answers.role).toBeUndefined();
  expect(readSetupFile(home).answers.url).toBeUndefined();
  lines = [];
  await run(['--status', '--json'], deps());
  expect(lines.join('\n')).not.toContain(FIRST);
  expect(JSON.parse(lines[0]!).observations.filter((fact: { id: string }) => fact.id === 'journey')).toMatchObject([{ detail: 'join', deployment: SECOND }]);
});

for (const bound of [FIRST, SECOND]) for (const hasDefault of [false, true]) it(`uses the repository binding to ${bound} ${hasDefault ? 'ahead of the other default' : 'without a default'}`, async () => {
  membership(FIRST); membership(SECOND);
  if (hasDefault) recordDefaultDeployment(bound === FIRST ? SECOND : FIRST, { mycoHome: home });
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  writeRegistryEntry({ version: 2, root: repo, projectId: 'proj_bound', serverUrl: bound, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  const calls: string[] = [];
  expect(await run(['--no-agents', '--no-runner'], { ...deps(), cwd: repo, fetch: online(calls) })).toBe(0);
  expect(questions).toEqual([]);
  expect(errors).toEqual([]);
  expect(lines).toContain(`This repository sends to ${bound}; continuing.`);
  expect(calls.every(url => url === bound)).toBe(true);
  expect(readSetupFile(home).answers.role).toBeUndefined();
  expect(readSetupFile(home).answers.makeDefault).toBeUndefined();
  expect(readDefaultDeployment(home)?.serverUrl).toBe(hasDefault ? bound === FIRST ? SECOND : FIRST : undefined);
});

for (const bound of [false, true]) it(`re-resolves an inferred repository after a ${bound ? 'bound' : 'unbound'} run`, async () => {
  membership(FIRST); membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home });
  const repositories = ['a', 'b'].map(name => {
    const repo = path.join(scratch, name);
    fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
    return repo;
  });
  const connect = (root: string, serverUrl: string) => {
    const entry = { version: 2 as const, root, projectId: `proj_${path.basename(root)}`, serverUrl, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 };
    writeRegistryEntry(entry, { mycoHome: home });
    return entry;
  };
  if (bound) connect(repositories[0]!, FIRST);
  const joined: string[] = [];
  const join = async (args: readonly string[]) => {
    const root = args[args.indexOf('--root') + 1]!;
    joined.push(root);
    return connect(root, args[0]!);
  };
  for (const cwd of repositories) {
    lines = [];
    expect(await run(['--no-agents', '--no-runner'], { ...deps(), cwd, fetch: online(), join })).toBe(0);
    expect(lines.at(-1)).toContain(cwd);
  }
  expect(readSetupFile(home).answers.root).toBeUndefined();
  expect(joined).toEqual(bound ? [repositories[1]!] : repositories);
  expect(readRegistryEntry(repositories[1]!, home)?.serverUrl).toBe(SECOND);
  expect(questions).toEqual([]);
  expect(errors).toEqual([]);
});

for (const saved of [false, true]) it(`keeps ${saved ? 'a saved' : 'an explicit'} root and an explicit default choice on an inferred journey`, async () => {
  membership(FIRST); membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home });
  const root = path.join(scratch, 'chosen');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  if (saved) saveSetupFile(home, { version: 1, answers: { root }, consented: {} });
  writeRegistryEntry({ version: 2, root, projectId: 'proj_chosen', serverUrl: FIRST, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  expect(await run([...(saved ? [] : ['--root', root]), '--default', '--no-agents', '--no-runner'], { ...deps(), fetch: online() })).toBe(0);
  expect(readSetupFile(home).answers).toMatchObject({ root, makeDefault: true });
  expect(readDefaultDeployment(home)?.serverUrl).toBe(FIRST);
  expect(questions).toEqual([]);
});

it('keeps the default on an inferred journey despite a saved default choice', async () => {
  membership(FIRST); membership(SECOND);
  recordDefaultDeployment(SECOND, { mycoHome: home });
  const root = path.join(scratch, 'bound');
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  writeRegistryEntry({ version: 2, root, projectId: 'proj_bound', serverUrl: FIRST, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  saveSetupFile(home, { version: 1, answers: { makeDefault: true, noAgents: true, runWork: false }, consented: {} });
  expect(await run([], { ...deps(), cwd: root, fetch: online() })).toBe(0);
  expect(readDefaultDeployment(home)?.serverUrl).toBe(SECOND);
  expect(readSetupFile(home).answers.makeDefault).toBe(true);
  expect(questions).toEqual([]);
});

for (const damaged of ['local', 'runner'] as const) it(`names the unreadable ${damaged} record and explicit role remedies without prompting`, async () => {
  membership(FIRST);
  let file: string;
  if (damaged === 'local') {
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
    file = peekLocalPaths(home).recordFile;
  } else file = runnerRecord(FIRST);
  fs.writeFileSync(file, '{', { mode: 0o600 });
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(errors.join('\n')).toContain(file);
  expect(errors.join('\n')).toContain(damaged === 'local' ? 'or pass --join, --create or --runner' : 'or pass --run-work or --no-runner');
  expect(readSetupFile(home).answers.role).toBeUndefined();
  if (damaged === 'local') {
    const facts = await observeSetupStatus(home, {}, { ...deps(), local: { native: { library: null, vec0: null }, service: { runner: () => { throw new Error('fixture service unavailable'); } } } });
    expect(facts.filter(fact => fact.target === 'local').map(fact => fact.id)).toEqual(expect.arrayContaining(['deployment.create', 'deployment.signin', 'deployment.owner', 'deployment.serving', 'journey']));
  }
});

it('combines membership and runner records only for guided setup', async () => {
  membership(FIRST); runnerRecord(FIRST);
  expect(observeSetupJourneys(home).guidedJourneys).toEqual([{ role: 'join', url: FIRST }]);
  expect(observeSetupJourneys(home).journeys).toEqual([{ role: 'join', url: FIRST }, { role: 'runner', url: FIRST }]);
  const observed = await observeSetupStatus(home, {}, { ...deps(), worker: { home: scratch, runner: () => { throw new Error('fixture service unavailable'); } } });
  expect(observed.filter(fact => fact.id === 'journey')).toMatchObject([{ detail: 'join', deployment: FIRST }, { detail: 'runner', deployment: FIRST }]);
  expect(await run(['--no-runner'], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers).toMatchObject({ runWork: false });
});

for (const runner of [undefined, FIRST, SECOND]) it(`observes runner choice only from enrollment at the joined Deployment: ${runner ?? 'none'}`, () => {
  membership(FIRST);
  if (runner) runnerRecord(runner);
  const journey = observeSetupJourneys(home).guidedJourneys.find(journey => journey.role === 'join')!;
  const runWork = observeSetupRunWork(home, journey.url!);
  expect(runWork).toBe(runner === FIRST);
  const file = readSetupFile(home);
  applyObservedSetupJourney(file, { ...journey, runWork });
  saveSetupFile(home, file);
  expect(readSetupFile(home).answers.runWork).toBeUndefined();
});

for (const saved of [false, true]) for (const runWork of [false, true]) it(`retains ${saved ? 'saved' : 'flagged'} runner choice ${runWork} over observed enrollment`, () => {
  const file = readSetupFile(home);
  if (saved) {
    saveSetupFile(home, { ...file, answers: { runWork } });
    file.answers = readSetupFile(home).answers;
  } else file.answers = parseSetupOptions([runWork ? '--run-work' : '--no-runner']).answers;
  applyObservedSetupJourney(file, { role: 'join', url: FIRST, runWork: !runWork });
  saveSetupFile(home, file);
  expect(file.answers.runWork).toBe(runWork);
  expect(readSetupFile(home).answers.runWork).toBe(runWork);
});

for (const enrolled of [false, true]) for (const choice of ['observed', 'flagged', 'saved'] as const) it(`keeps ${choice} runner choice separate from an answered Deployment choice with enrollment ${enrolled}`, async () => {
  membership(FIRST); membership(SECOND);
  if (enrolled) runnerRecord(FIRST);
  if (choice === 'saved') saveSetupFile(home, { version: 1, answers: { runWork: !enrolled }, consented: {} });
  const ready = choice === 'observed' ? readyJoin() : deps();
  const flags = choice === 'flagged' ? [enrolled ? '--no-runner' : '--run-work'] : enrolled && choice === 'observed' ? ['--runner-service', 'skip'] : [];
  expect(await run(flags, { ...ready, ask: async question => {
    questions.push(question);
    expect(question).toContain('Which Myco');
    return '1';
  } })).toBe(choice === 'observed' ? 0 : 2);
  expect(questions).toHaveLength(1);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: FIRST });
  expect(readSetupFile(home).answers.runWork).toBe(choice === 'observed' ? undefined : !enrolled);
  if (choice === 'observed') {
    expect(await run(['--status'], ready)).toBe(0);
    expect({ code: await run([], ready), errors }).toEqual({ code: 0, errors: [] });
    expect(questions).toHaveLength(1);
    expect(readSetupFile(home).answers.runWork).toBeUndefined();
  }
});

it('observes runner choice when resuming a saved explicit join', async () => {
  membership(FIRST);
  const ready = readyJoin();
  expect(await run(['--join', FIRST], { ...ready, fetch: deps().fetch })).toBe(2);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: FIRST });
  expect(readSetupFile(home).answers.runWork).toBeUndefined();
  errors = [];
  expect({ code: await run([], ready), errors }).toEqual({ code: 0, errors: [] });
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers.runWork).toBeUndefined();
});

for (const source of ['flag', 'role answer', 'something else'] as const) for (const damaged of [false, true]) it(`asks and saves the runner choice once for a fresh join from ${source}, unrelated damage ${damaged}`, async () => {
  if (damaged) fs.writeFileSync(runnerRecord(SECOND), '{', { mode: 0o600 });
  if (source === 'something else') { membership(FIRST); membership(SECOND); }
  const ready = readyJoin();
  const first = await run(source === 'flag' ? ['--join', FIRST] : [], { ...ready,
    login: async () => { membership(FIRST); return true; },
    ask: async question => {
      questions.push(question);
      if (source === 'something else' && question.includes('Which Myco')) return '3';
      if (source !== 'flag' && question.includes('What should this machine do?')) return '2';
      if (source !== 'flag' && question.includes('What is your Myco')) return FIRST;
      expect(question).toContain('Make this machine a runner?');
      return 'no';
    },
  });
  expect({ first, errors }).toEqual({ first: 0, errors: [] });
  expect(questions.filter(question => question.includes('Make this machine a runner?'))).toHaveLength(1);
  expect(questions).toHaveLength(source === 'flag' ? 1 : source === 'role answer' ? 3 : 4);
  expect(readSetupFile(home).answers).toMatchObject({ role: 'join', url: FIRST, runWork: false });
  questions = []; errors = [];
  expect({ code: await run([], ready), errors, questions }).toEqual({ code: 0, errors: [], questions: [] });
  expect(readSetupFile(home).answers.runWork).toBe(false);
});

for (const selection of ['saved', 'inferred', 'chooser'] as const) it(`ignores unrelated unreadable runner enrollment for a ${selection} join`, async () => {
  membership(FIRST);
  fs.writeFileSync(runnerRecord(SECOND), '{', { mode: 0o600 });
  if (selection === 'saved') saveSetupFile(home, { version: 1, answers: { role: 'join', url: FIRST }, consented: {} });
  if (selection === 'chooser') membership(SECOND);
  const ready = readyJoin();
  expect({ code: await run([], { ...ready, ask: async question => {
    questions.push(question);
    if (selection === 'chooser' && question.includes('Which Myco')) return '1';
    throw new Error(`Unexpected prompt: ${question}`);
  } }), errors }).toEqual({ code: 0, errors: [] });
  expect(questions).toHaveLength(selection === 'chooser' ? 1 : 0);
  expect(readSetupFile(home).answers.runWork).toBeUndefined();
});

it('refuses unreadable runner enrollment for a saved join before any prompt', async () => {
  membership(FIRST);
  runnerRecord(FIRST);
  const record = runnerRecordPath(FIRST, home);
  fs.writeFileSync(record, '{', { mode: 0o600 });
  saveSetupFile(home, { version: 1, answers: { role: 'join', url: FIRST }, consented: {} });
  expect(await run([], deps())).toBe(2);
  expect(errors.join('\n')).toContain(record);
  expect(errors.join('\n')).toContain('or pass --run-work or --no-runner');
  expect(questions).toEqual([]);
  expect(readSetupFile(home).answers.runWork).toBeUndefined();
});

it('keeps all observations unsaved when runner enrollment is observed separately', () => {
  const file = readSetupFile(home);
  applyObservedSetupJourney(file, { role: 'join', url: FIRST, root: scratch });
  applyObservedSetupRunWork(file, false);
  file.answers.noAgents = true;
  saveSetupFile(home, file);
  expect(file.answers).toMatchObject({ role: 'join', url: FIRST, root: scratch, runWork: false });
  expect(readSetupFile(home).answers).toEqual({ noAgents: true });
});

for (const runWork of [false, true]) it(`preserves an answered runner choice of ${runWork} during observation`, () => {
  const file = { version: 1 as const, answers: { role: 'join' as const, url: FIRST, runWork }, consented: {} };
  applyObservedSetupRunWork(file, !runWork);
  saveSetupFile(home, file);
  expect(readSetupFile(home).answers).toEqual({ role: 'join', url: FIRST, runWork });
});

it('asks the role instead of inferring guided creation for a fronted local Deployment', async () => {
  createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, origin: 'https://fronted.invalid' }, { library: null, vec0: null }, peekLocalPaths(home));
  expect(await run([], { ...deps(), ask: async question => { questions.push(question); return null; } })).toBe(2);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain('What should this machine do?');
  expect(errors.join('\n')).not.toContain('loopback only');
});

it('chooses a default membership alongside a runner, hosted creation or local creation', async () => {
  runnerRecord(FIRST);
  writeDeploymentRecord({ accountId: 'a'.repeat(32), workerName: 'w', databaseName: 'd', bucketName: 'b', versionId: null, deployedAt: new Date(0).toISOString(), url: FIRST }, home);
  createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
  membership(SECOND); recordDefaultDeployment(SECOND, { mycoHome: home });
  expect(await run([], deps())).toBe(2);
  expect(questions).toEqual([]);
  expect(lines).toContain(`This machine joins ${SECOND}; continuing.`);
});

it('lists different runner and member Deployments as choices without a default', async () => {
  runnerRecord(FIRST); membership(SECOND);
  expect(await run([], { ...deps(), ask: async question => { questions.push(question); return null; } })).toBe(2);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain(`joins ${SECOND}`);
  expect(questions[0]).toContain(`runs Myco’s work for ${FIRST}`);
});

it('keeps observed identity out of every save while preserving answered choices and consent', () => {
  const file = readSetupFile(home);
  applyObservedSetupJourney(file, { role: 'create', target: 'cloudflare' });
  file.answers.url = FIRST;
  file.answers.cutover = true;
  file.consented.device = 'a'.repeat(64);
  saveSetupFile(home, file);
  file.answers.runWork = false;
  saveSetupFile(home, { ...file });
  expect(file.answers).toMatchObject({ role: 'create', url: FIRST });
  expect(readSetupFile(home)).toEqual({ version: 1, answers: { cutover: true, runWork: false }, consented: { device: 'a'.repeat(64) } });
});
