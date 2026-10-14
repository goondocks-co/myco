import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/setup.js';
import { run as dryCutover } from '@myco/cli/cutover.js';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { observeSetupStatus, type Observation } from '@myco/setup/observe.js';
import { saveSetupFile } from '@myco/setup/answers.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { writeDeploymentMembership, writeRegistryEntry, deploymentPath } from '@myco/member/registry.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';
import { newRunnerBearer, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { statusHome, STATUS_URL, STATUS_NOW } from './fixtures/status-home.js';
import { Database } from 'bun:sqlite';
import { provisionGlobally } from '@myco/cli/member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';

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
    expect(text).toContain('Agent hooks: Out of date; run myco member provision --refresh.');
    expect(text).toContain(`myco member provision --refresh`);
    expect(text).toContain('Default Deployment: Not selected. New repositories will not automatically join');
    expect(text).toContain(`myco login --default <address>`);
    expect(text).not.toContain('1.4 migration:');
    expect(text).toContain('Capture: 12 repositories: 10 with nothing waiting; 2 need attention.');
    expect(text).toContain(inside ? `${fixture.repositories[3]}: bound here.` : `12 repositories send to ${STATUS_URL}`);
    expect(text).not.toContain('Choose a repository');
    expect(text).not.toContain('Choose --join');
    expect(text).not.toContain('unasked');
    expect(text).not.toContain('machine.');
    expect(text).toContain(`cd '${fixture.repositories[0]}' && myco member drain`);
    expect(text).toContain('delivery paused until');
    expect(lines.filter(line => line.includes(fixture.repositories[0]))).toHaveLength(1);
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
  expect(lines.filter(line => line.includes('Setup:'))).toHaveLength(2);
  const facts = await observeSetupStatus(fixture.home, { url: STATUS_URL, role: 'join', runnerService: 'skip', noAgents: true }, deps());
  expect(facts.filter(fact => fact.id === 'journey').map(fact => [fact.deployment, fact.detail]).sort()).toEqual([[STATUS_URL, 'join'], [second, 'join'], [STATUS_URL, 'runner']].sort());
});

it('keeps complete status at zero and unreadable observations at four', async () => {
  recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home });
  recordProvision(fixture.home, { serverUrl: STATUS_URL, agents: [], version: 'synthetic', at: 1 }, { replace: true });
  expect(await run(['--status', '--no-agents'], deps())).toBe(0);
  fs.writeFileSync(deploymentPath(STATUS_URL, fixture.home), '{', { mode: 0o600 });
  lines = [];
  expect(await run(['--status'], deps())).toBe(4);
});


it('keeps an inferred repository binding healthy across multiple memberships', async () => {
  const second = 'https://second.example';
  writeDeploymentMembership({ serverUrl: second, token: 'T'.repeat(43), machineId: 'second-machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
  recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home });
  recordProvision(fixture.home, { serverUrl: STATUS_URL, agents: [], version: 'synthetic', at: 1 }, { replace: true });
  expect(await run(['--status', '--no-agents'], { ...deps(), cwd: fixture.repositories[3] })).toBe(0);
  expect(lines.join('\n')).not.toContain('to change it');
  expect(lines.join('\n')).toContain(`${fixture.repositories[3]}: bound here.`);
  expect(lines.filter(line => line.includes('bound here'))).toHaveLength(1);
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

const legacyCases = [
  ['none', 'complete', 'No Myco 1.4 capture blocks setup.', null],
  ['unmoved', 'incomplete', 'Agent setup deferred until cutover.', 'Myco 1.4 data has not been moved; run myco setup --cutover to preview and move it.'],
  ['needs-destination', 'complete', 'Moved by an earlier version; run `myco cutover --dry-run` to confirm where each project went.', 'Run myco setup --cutover to confirm each project destination, or preview manually with myco cutover --dry-run.'],
  ['handover-pending', 'incomplete', 'Agent setup deferred until cutover.', 'Myco 1.4 capture has not handed over; run myco setup --cutover to preview the handover.'],
  ['partial', 'complete', 'No Myco 1.4 capture blocks setup.', 'Some Myco 1.4 data has not finished moving; run myco setup --cutover to preview and resume what remains.'],
  ['changed', 'incomplete', 'Myco 1.4 wrote more data after migration.', 'Myco 1.4 wrote more data after migration. Keep its files and run myco setup --cutover to review the new data.'],
  ['moved', 'complete', 'No Myco 1.4 capture blocks setup.', 'Myco 1.4 data has been moved.'],
  ['unavailable', 'unavailable', 'Cannot read receipt.', 'unavailable-copy'],
] as const;
for (const [legacy, state, detail, expected] of legacyCases) it(`explains legacy ${legacy} as a whole sentence`, () => {
  const text = renderSetupStatus([{ id: 'legacy', scope: fixture.home, state, detail: `${legacy} ${detail}`,
    ...(legacy === 'needs-destination' ? { hint: detail } : {}) }]).join('\n');
  expect(text).toBe(expected === null ? '' : `1.4 migration: ${legacy === 'unavailable' ? `Myco 1.4 migration records could not be read: Cannot read receipt. Inspect ${fixture.home}, then run myco setup --cutover.` : expected}`);
});

it('separates split repository counts and capture, with home facts above default-first groups', async () => {
  const other = 'https://alpha.example';
  fixture = statusHome(path.join(scratch, 'split'), [STATUS_URL, other]);
  recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home });
  const before = snapshot(scratch);
  await run(['--status'], deps());
  const text = lines.join('\n');
  const first = text.slice(text.indexOf(`Deployment ${STATUS_URL}`), text.indexOf(`Deployment ${other}`));
  const second = text.slice(text.indexOf(`Deployment ${other}`));
  expect(first).toContain(`6 repositories send to ${STATUS_URL}`);
  expect(second).toContain(`6 repositories send to ${other}`);
  expect(first).toContain('Capture: 6 repositories: 4 with nothing waiting; 2 need attention.');
  expect(second).toContain('Capture: 6 repositories: 5 with nothing waiting; 1 needs attention.');
  expect(first).toContain(fixture.repositories[0]);
  expect(first).not.toContain(fixture.repositories[6]);
  expect(second).toContain(fixture.repositories[6]);
  expect(second).not.toContain(fixture.repositories[0]);
  expect(lines.filter(line => line.startsWith('Agent hooks:'))).toHaveLength(1);
  expect(lines.filter(line => line.startsWith('Default Deployment:'))).toHaveLength(1);
  expect(text.indexOf('Agent hooks:')).toBeLessThan(text.indexOf('Deployment https:'));
  expect(text).toContain('1 event waiting; delivery paused until');
  expect(text).toContain('1 refused event in the last 7 days, refused by your Myco server');
  expect(text).not.toContain('0 unreadable log lines');
  expect(text).not.toContain('..');
  expect(snapshot(scratch)).toEqual(before);
  lines = [];
  await run(['--status', '--json'], deps());
  const facts = JSON.parse(lines[0]).observations as Observation[];
  for (const id of ['legacy', 'default', 'machine.agents']) {
    expect(facts.filter(fact => fact.id === id)).toHaveLength(1);
    expect(facts.find(fact => fact.id === id)).not.toHaveProperty('deployment');
  }
  lines = [];
  await run(['--status'], { ...deps(), cwd: fixture.repositories[7] });
  expect(lines.filter(line => line.includes('bound here'))).toEqual([`  Repository: ${fixture.repositories[7]}: bound here.`]);
});

it('lists joined addresses without choosing an arbitrary default and orders alphabetically', async () => {
  const other = 'https://alpha.example';
  writeDeploymentMembership({ serverUrl: other, token: 'T'.repeat(43), machineId: 'second-machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
  await run(['--status'], deps());
  const text = lines.join('\n');
  expect(text).toContain(`Joined: ${other}, ${STATUS_URL}. Choose one with myco login --default <address> (approves this machine again).`);
  expect(text.indexOf(`Deployment ${other}`)).toBeLessThan(text.indexOf(`Deployment ${STATUS_URL}`));
  expect(text).toContain('No repositories send to this Deployment yet. Run myco member join from a repository.');
  expect(text).not.toContain('provision --server');
  lines = [];
  await run(['--status', '--join', STATUS_URL], deps());
  expect(lines.join('\n')).toContain(`Joined: ${other}, ${STATUS_URL}.`);
});

it('describes current global hooks against their recorded Deployment and shortens HOME paths once', () => {
  const root = path.join(process.env.HOME!, 'Repos', 'synthetic');
  const text = renderSetupStatus([
    { id: 'machine.agents', scope: fixture.home, state: 'complete', detail: 'current', hooksDeployment: STATUS_URL },
    { id: 'machine.backlog', scope: root, deployment: STATUS_URL, state: 'incomplete', detail: 'backlog', capture: { waiting: 1 } },
    { id: 'machine.latch', scope: root, deployment: STATUS_URL, state: 'incomplete', detail: 'hold-off', capture: { nextProbeAt: STATUS_NOW } },
  ]).join('\n');
  expect(text).toContain(`Agent hooks: set up for ${STATUS_URL}`);
  expect(text).toContain("cd ~/'Repos/synthetic' && myco member drain");
  expect(text).not.toContain(process.env.HOME!);
  expect(text).toContain('Capture: 1 repository:');
  expect(text.match(/Repos\/synthetic/g)).toHaveLength(1);
  expect(text).toContain(`    synthetic: 1 event waiting; delivery paused until ${new Date(STATUS_NOW).toISOString()}.`);
});

it('uses recorded global hooks even when saved answers declined agents for another Deployment', async () => {
  const other = 'https://hooks.example';
  recordProvision(fixture.home, { serverUrl: other, agents: ['claude-code'], version: 'stale-version', at: 1 });
  const facts = await observeSetupStatus(fixture.home, { role: 'join', url: STATUS_URL, noAgents: true }, deps());
  expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ detail: 'stale', state: 'incomplete', hooksDeployment: other });
  expect(renderSetupStatus(facts).join('\n')).toContain('Agent hooks: Out of date; run myco member provision --refresh.');
});

for (const backupOnly of [false, true]) it(`reports installed 2.0 capture separately from ${backupOnly ? 'alpha backup-only' : 'unmoved'} history`, async () => {
  const restore = bindSandboxChildHome(scratch, { MYCO_HOME: fixture.home });
  try {
    const vault = path.join(fixture.home, 'groves', 'retained', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    const db = new Database(vault);
    db.run("CREATE TABLE sessions (body TEXT, project_id TEXT DEFAULT 'proj_old')");
    db.run("INSERT INTO sessions (body) VALUES ('retained history')");
    db.close();
    if (backupOnly) {
      const copy = path.join(scratch, 'alpha-backup.db');
      fs.copyFileSync(vault, copy);
      fs.writeFileSync(path.join(fixture.home, 'member', 'cutover.json'), JSON.stringify({ backups: { [vault]: { copy, ...readVaultContent(copy), at: 1 } } }), { mode: 0o600 });
    }
    expect(provisionGlobally('claude-code', null, fixture.home, { serverUrl: STATUS_URL }).kind).toBe('provisioned');
    const bytes = fs.readFileSync(vault);
    expect(legacyMigrationState(fixture.home).state).toBe(backupOnly ? 'needs-destination' : 'unmoved');
    const facts = await observeSetupStatus(fixture.home, { role: 'join', url: STATUS_URL }, deps());
    expect(facts.find(fact => fact.id === 'machine.agents')?.detail).not.toBe('deferred-legacy');
    const text = renderSetupStatus(facts).join('\n');
    expect(text).toContain('Agent hooks: Myco 2.0 capture is installed');
    expect(text).not.toContain('1.4 still owns agent capture');
    expect(text).toContain(backupOnly ? 'Some Myco 1.4 projects need a destination' : 'Myco 1.4 data has not been moved');
    const doctor = (await homeReport(fixture.home, { ...deps(), worker: { runner: () => { throw new Error('No service calls'); } } })).map(check => check.detail).join('\n');
    expect(doctor).toContain('hooks (');
    expect(doctor).toContain('are installed; capture execution not checked');
    expect(doctor).not.toContain('still own capture');
    recordProvision(fixture.home, { serverUrl: STATUS_URL, agents: [], version: 'earlier-build', at: 1 }, { replace: true });
    const stale = await observeSetupStatus(fixture.home, { role: 'join', url: STATUS_URL, noAgents: true }, deps());
    expect(stale.find(fact => fact.id === 'machine.agents')).toMatchObject({ memberCapture: true, state: 'incomplete' });
    expect(renderSetupStatus(stale).join('\n')).toContain('Myco 2.0 capture is installed. Out of date');
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    const installed = fs.readFileSync(settings, 'utf8');
    for (const mismatch of [installed.replaceAll('--credential registry', '--credential env'), installed.replaceAll(resolveManagedBinaryPath(fixture.home), '/foreign/bin/myco')]) {
      expect(mismatch).not.toBe(installed);
      fs.writeFileSync(settings, mismatch);
      const changed = await observeSetupStatus(fixture.home, { role: 'join', url: STATUS_URL }, deps());
      expect(changed.find(fact => fact.id === 'machine.agents')?.memberCapture).toBeUndefined();
      expect(renderSetupStatus(changed).join('\n')).not.toContain('Myco 2.0 capture is installed');
    }
    expect(fs.readFileSync(vault)).toEqual(bytes);
  } finally { restore(); }
});
it('explains destination selection when legacy still owns capture', () => {
  expect(renderSetupStatus([{ id: 'legacy', scope: fixture.home, state: 'incomplete', detail: 'needs-destination Agent setup deferred until cutover.' }])).toEqual([
    '1.4 migration: Some Myco 1.4 projects need a destination; run myco setup --cutover to preview the handover.',
  ]);
});

it('keeps a runner-only journey independent of absent member hooks', async () => {
  const home = path.join(scratch, 'runner-only');
  const record = runnerRecordPath(STATUS_URL, home);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ version: 1, serverUrl: STATUS_URL, name: 'Synthetic runner', token: newRunnerBearer(), runnerId: 'rn_synthetic', deploymentId: 'synthetic' }), { mode: 0o600 });
  const facts = await observeSetupStatus(home, { role: 'runner', url: STATUS_URL, runnerService: 'skip' }, deps());
  expect(facts.some(fact => fact.id === 'machine.agents')).toBe(false);
});

it('reports stored home facts even when no journey remains', async () => {
  const home = path.join(scratch, 'home-facts-only');
  recordProvision(home, { serverUrl: STATUS_URL, agents: ['claude-code'], version: 'stale-version', at: 1 });
  recordDefaultDeployment(STATUS_URL, { mycoHome: home });
  const facts = await observeSetupStatus(home, {}, deps());
  expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ detail: 'stale', hooksDeployment: STATUS_URL });
  expect(facts.find(fact => fact.id === 'default')).toMatchObject({ detail: STATUS_URL });
  for (const fact of facts) expect(fact).not.toHaveProperty('deployment');
});

it('prints one declined runner-service line while preserving registration and unavailable observations', async () => {
  const record = runnerRecordPath(STATUS_URL, fixture.home);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ version: 1, serverUrl: STATUS_URL, name: 'Synthetic runner', token: newRunnerBearer(), runnerId: 'rn_synthetic', deploymentId: 'synthetic' }), { mode: 0o600 });
  saveSetupFile(fixture.home, { version: 1, answers: { role: 'runner', url: STATUS_URL, runnerService: 'skip' }, consented: {} });
  await run(['--status'], deps());
  const declined = lines.filter(line => /Runner start at login:|Runner service:|Runner agents:/.test(line));
  expect(declined).toEqual([`  Runner start at login: Declined. Run myco runner run --server ${STATUS_URL} when ready.`]);
  expect(lines.join('\n')).toContain('Runner: live: Synthetic runner');
  expect(renderSetupStatus([
    { id: 'runner.service.choice', scope: STATUS_URL, deployment: STATUS_URL, state: 'complete', detail: 'skip' },
    { id: 'runner.service', scope: STATUS_URL, deployment: STATUS_URL, state: 'unavailable', detail: 'cannot read service' },
  ]).join('\n')).toContain('Runner service: Could not read Runner service: cannot read service.');
});

it('prints the agent-hook label once when setup is missing', () => {
  expect(renderSetupStatus([{ id: 'machine.agents', scope: fixture.home, state: 'absent', detail: 'none', hooksDeployment: STATUS_URL }])).toEqual([
    `Agent hooks: Not set up; run myco member provision --server ${STATUS_URL}.`,
  ]);
});

it('observes installed 1.4 hooks as incomplete capture with friendly copy and exit 3', async () => {
  const restore = bindSandboxChildHome(scratch, { MYCO_HOME: fixture.home });
  try {
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${fixture.home}/bin/myco hook session-start --myco-managed` }] }] } }));
    const facts = await observeSetupStatus(fixture.home, { role: 'join', url: STATUS_URL }, deps());
    expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'incomplete', detail: 'legacy-hooks' });
    expect(await run(['--status'], deps())).toBe(3);
    const row = lines.find(line => line.includes('Agent hooks:'));
    expect(row).toContain('Myco 1.4 still captures your agents; run myco setup --cutover to hand over.');
    expect(row).not.toContain(scratch);
    expect(row).not.toContain('Could not read');
  } finally { restore(); }
});


for (const explicit of [true, false]) it(`status and dry run confirm the same ${explicit ? 'explicit legacy homes' : 'legacy home directory'} source set`, async () => {
  const legacyHomeDir = path.join(scratch, 'source-home');
  const sourceHome = path.join(legacyHomeDir, explicit ? 'retained' : '.myco');
  const vault = path.join(sourceHome, 'groves', 'retained', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, created_at) VALUES ('source-session', 'proj_status_1', ?, 'claude-code', 1700000000, 1700000060, 'completed', 1700000000)", [fixture.repositories[0]]);
  db.close();
  const bytes = fs.readFileSync(vault);
  let passes = 0;
  const fetch = Object.assign(async (_input: unknown, init?: RequestInit) => {
    passes++;
    const body = JSON.parse(String(init?.body)) as { eventGroups: string[][] };
    return Response.json({ persisted: true, confirmed: true, eventIds: body.eventGroups.flat(), sporeIds: [], lineageIds: [] });
  }, { preconnect: () => {} });
  const facts = await observeSetupStatus(fixture.home, {}, { ...deps(), fetch, legacyHomeDir, ...(explicit ? { legacyHomes: [sourceHome] } : {}) });
  expect(facts.find(fact => fact.id === 'legacy')?.detail).toMatch(/^partial /);
  expect(passes).toBe(1);
  expect(await dryCutover(['--dry-run', ...(explicit ? ['--legacy-home', sourceHome] : [])], {
    mycoHome: fixture.home, env: { ...process.env, HOME: legacyHomeDir }, machineId: 'synthetic-machine', fetch,
    stdout: line => lines.push(line), stderr: line => { throw new Error(line); },
  })).toBe(true);
  expect(passes).toBe(1);
  expect(lines.join('\n')).toContain('only the transcript pass remains');
  expect(fs.readFileSync(vault)).toEqual(bytes);
});

it('reports legacy hooks before any 2.0 membership or provision record exists', async () => {
  const home = path.join(scratch, 'legacy-only');
  const restore = bindSandboxChildHome(scratch, { MYCO_HOME: home });
  try {
    const file = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'myco hook session-start --myco-managed' }] }] } }));
    const facts = await observeSetupStatus(home, {}, deps());
    expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'incomplete', detail: 'legacy-hooks' });
    expect(renderSetupStatus(facts).join('\n')).toContain('Myco 1.4 still captures your agents; run myco setup --cutover to hand over.');
  } finally { restore(); }
});
