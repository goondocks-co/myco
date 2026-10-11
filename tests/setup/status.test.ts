import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/setup.js';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { observeSetupStatus, type Observation } from '@myco/setup/observe.js';
import { saveSetupFile } from '@myco/setup/answers.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { writeDeploymentMembership, writeRegistryEntry, deploymentPath } from '@myco/member/registry.js';
import { newRunnerBearer, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { statusHome, STATUS_URL, STATUS_NOW } from './fixtures/status-home.js';

let scratch: string;
let fixture: ReturnType<typeof statusHome>;
let lines: string[];
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-status-'));
  fixture = statusHome(scratch);
  lines = [];
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const deps = () => ({
  mycoHome: fixture.home, cwd: scratch, now: () => STATUS_NOW, agents: () => ['claude-code'],
  stdout: (line: string) => lines.push(line), stderr: (line: string) => { throw new Error(line); },
  fetch: Object.assign(async () => { throw new Error('status must not call the network'); }, { preconnect: () => {} }),
  worker: { runner: () => { throw new Error('status must not query services'); } },
});
function snapshot(directory: string): unknown {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}

for (const args of [[], ['--join', STATUS_URL]]) for (const inside of [false, true]) {
  it(`observes twelve repositories ${inside ? 'inside' : 'outside'} a repository with ${args.length ? '--join' : 'no journey flags'}`, async () => {
    const before = snapshot(scratch);
    expect(await run(['--status', ...args], { ...deps(), cwd: inside ? fixture.repositories[3] : scratch })).toBe(3);
    const text = lines.join('\n');
    expect(text).toContain(`Deployment ${STATUS_URL}`);
    expect(text).toContain('Signed in: This machine is signed in');
    expect(text).toContain('Agent hooks: Installed hooks, MCP registration, or skills do not match');
    expect(text).toContain(`myco member provision --server ${STATUS_URL}`);
    expect(text).toContain('Default Deployment: Not selected. New repositories will not automatically join');
    expect(text).toContain(`myco login --default ${STATUS_URL}`);
    expect(text).toContain('1.4 migration:');
    expect(text).toContain('Capture: 12 repositories: 10 with nothing waiting; 2 need attention.');
    expect(text).toContain(inside ? `${fixture.repositories[3]}: bound here.` : `12 repositories send to ${STATUS_URL}`);
    expect(text).not.toContain('Choose a repository');
    expect(text).not.toContain('Choose --join');
    expect(text).not.toContain('unasked');
    expect(text).not.toContain('machine.');
    expect(text).toContain(`cd '${fixture.repositories[0]}' && myco member drain`);
    expect(text).toContain('Capture hold-off: Delivery held off');
    expect(text).toContain(`cd '${fixture.repositories[1]}' && myco logs`);
    expect(text).not.toContain(fixture.repositories[2]);
    for (const line of lines.filter(line => /Signed in:|bound here|nothing waiting|Setup:/.test(line))) expect(line).not.toMatch(/Run |myco member|myco logs/);
    expect(snapshot(scratch)).toEqual(before);
  });
}

it('preserves JSON observation keys, ids, scope and state values', async () => {
  expect(await run(['--status', '--json'], deps())).toBe(3);
  const body = JSON.parse(lines[0]) as { observations: Observation[] };
  expect(Object.keys(body)).toEqual(['observations']);
  const ids = [...new Set(body.observations.map(fact => fact.id))].sort();
  expect(ids).toEqual(['default', 'journey', 'legacy', 'machine.agents', 'machine.backlog', 'machine.latch', 'machine.refusals', 'machine.signin', 'project', 'runner.choice'].sort());
  for (const fact of body.observations) {
    expect(Object.keys(fact)).toEqual(expect.arrayContaining(['id', 'scope', 'state', 'detail']));
    expect(['absent', 'incomplete', 'complete', 'unavailable']).toContain(fact.state);
  }
  expect(body.observations.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'incomplete', detail: 'stale' });
  expect(body.observations.find(fact => fact.id === 'machine.refusals' && fact.scope === fixture.repositories[2])).toMatchObject({ state: 'complete' });
});

it('reports missing and elsewhere bindings for the current repository', async () => {
  const root = fixture.repositories[3];
  writeRegistryEntry({ version: 2, root, projectId: 'proj_other', serverUrl: 'https://elsewhere.example', token: 'E'.repeat(43), machineId: 'synthetic', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
  await run(['--status', '--join', STATUS_URL], { ...deps(), cwd: root });
  expect(lines.join('\n')).toContain('bound elsewhere (https://elsewhere.example)');
  execFileSync('git', ['init', '-q', path.join(scratch, 'unbound')]);
  lines = [];
  await run(['--status', '--join', STATUS_URL], { ...deps(), cwd: path.join(scratch, 'unbound') });
  expect(lines.join('\n')).toContain('unbound: missing. Run myco member join');
});

it('observes every membership and runner record, retaining matching saved choices', async () => {
  const second = 'https://second.example';
  writeDeploymentMembership({ serverUrl: second, token: 'T'.repeat(43), machineId: 'second-machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
  const record = runnerRecordPath(STATUS_URL, fixture.home);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ version: 1, serverUrl: STATUS_URL, name: 'Synthetic runner', token: newRunnerBearer(), runnerId: 'rn_synthetic', deploymentId: 'synthetic' }), { mode: 0o600 });
  saveSetupFile(fixture.home, { version: 1, answers: { role: 'join', url: STATUS_URL, runnerService: 'skip', noAgents: true }, consented: {} });
  await run(['--status'], deps());
  expect(lines.join('\n')).toContain('Runner: live: Synthetic runner');
  expect(lines.join('\n')).toContain(`Deployment ${second}`);
  const facts = await observeSetupStatus(fixture.home, { url: STATUS_URL, role: 'join', runnerService: 'skip', noAgents: true }, deps());
  expect(facts.filter(fact => fact.id === 'journey').map(fact => [fact.deployment, fact.detail]).sort()).toEqual([[STATUS_URL, 'join'], [second, 'join'], [STATUS_URL, 'runner']].sort());
});

it('keeps complete status at zero and unreadable observations at four', async () => {
  recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home });
  expect(await run(['--status', '--no-agents'], deps())).toBe(0);
  fs.writeFileSync(deploymentPath(STATUS_URL, fixture.home), '{', { mode: 0o600 });
  lines = [];
  expect(await run(['--status'], deps())).toBe(4);
});


it('keeps an inferred repository binding healthy across multiple memberships', async () => {
  const second = 'https://second.example';
  writeDeploymentMembership({ serverUrl: second, token: 'T'.repeat(43), machineId: 'second-machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
  recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home });
  expect(await run(['--status', '--no-agents'], { ...deps(), cwd: fixture.repositories[3] })).toBe(0);
  expect(lines.join('\n')).not.toContain('to change it');
  expect(lines.join('\n')).toContain(`sends to ${STATUS_URL}`);
});

it('reports valid runners alongside unreadable records and deduplicates a joined runner', async () => {
  const bad = runnerRecordPath('https://bad.example', fixture.home);
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{', { mode: 0o600 });
  const good = runnerRecordPath(STATUS_URL, fixture.home);
  fs.mkdirSync(path.dirname(good), { recursive: true });
  fs.writeFileSync(good, JSON.stringify({ version: 1, serverUrl: STATUS_URL, name: 'Synthetic runner', token: newRunnerBearer(), runnerId: 'rn_synthetic', deploymentId: 'synthetic' }), { mode: 0o600 });
  for (const runWork of [true, false]) {
    lines = [];
    saveSetupFile(fixture.home, { version: 1, answers: { role: 'join', url: STATUS_URL, runWork, runnerService: 'skip', noAgents: true }, consented: {} });
    expect(await run(['--status'], deps())).toBe(4);
    expect(lines.filter(line => line.includes('Runner: live: Synthetic runner'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('Runner: This machine does not');
    expect(lines.join('\n')).toContain('Could not read Runner');
  }
});

it('never adds fix commands to healthy rows', () => {
  const facts: Observation[] = [
    { id: 'journey', detail: 'runner' }, { id: 'machine.agents', detail: 'current' },
    { id: 'machine.signin', detail: 'present' }, { id: 'project', detail: 'bound-here' },
    { id: 'runner.enrollment', detail: 'live: Synthetic' }, { id: 'runner.service', detail: 'running' },
    { id: 'runner.offer', detail: 'Service declined; start with myco runner run when ready.' },
  ].map(fact => ({ ...fact, state: 'complete', scope: STATUS_URL, deployment: STATUS_URL }));
  const text = renderSetupStatus(facts).join('\n');
  expect(text).not.toMatch(/Run |myco (setup|member|runner|logs)/);
});

it('offers inspection rather than writes when observations are unavailable', () => {
  const facts: Observation[] = ['machine.agents', 'machine.signin', 'project', 'runner.enrollment'].map(id => ({
    id, scope: STATUS_URL, deployment: STATUS_URL, state: 'unavailable', detail: 'Record cannot be read',
  }));
  const text = renderSetupStatus(facts).join('\n');
  expect(text).toContain('Could not read');
  expect(text).toContain('myco doctor');
  expect(text).not.toMatch(/myco (login|member provision|member join|setup)/);
});


it('uses the shared repository binding from a linked worktree without caching a verdict', async () => {
  const main = fixture.repositories[3];
  execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Synthetic fixture'], { cwd: main });
  const linked = path.join(scratch, 'linked');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'synthetic-linked', linked], { cwd: main });
  const before = snapshot(scratch);
  await run(['--status'], { ...deps(), cwd: linked });
  expect(lines.join('\n')).toContain(`${main}: bound here.`);
  expect(snapshot(scratch)).toEqual(before);
});


it('summarises bindings from a bare repository instead of treating its parent as the checkout', async () => {
  const bare = path.join(fixture.repositories[3], 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const before = snapshot(scratch);
  await run(['--status'], { ...deps(), cwd: bare });
  expect(lines.join('\n')).toContain(`12 repositories send to ${STATUS_URL}`);
  expect(lines.join('\n')).not.toContain('bound here');
  expect(snapshot(scratch)).toEqual(before);
});
