import { memberRig } from '../member/helpers/server.js';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { parseProvisionedHarnessReport } from '@myco-server-worker/core/harness-health.js';
import { beforeEach, afterEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploymentHarnessRanAt } from '@myco/symbionts/harness-attribution.js';
import { MemberSpool } from '@myco/member/spool.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { writeRegistryEntry, REGISTRY_VERSION, removeDeploymentForLogout, membershipTokenDigest, readDeploymentMembership, logoutBindings, withRegistryLock, registryEntryPath, deploymentPath } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { WorkerSessionEvidence } from '@myco/symbionts/worker-session-evidence.js';
import { reportHarnesses } from '@myco/cli/member-keep-current.js';
import { recordProvision, holdHookTrust, readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE, HARNESS_ACTIVITY_RETENTION_MS } from '@goondocks/myco-shared/harness-health';
import { MEMBER_SESSION_STATE_RETENTION_MS } from '@myco/member/constants.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const NOW = Math.trunc(Date.now() / 1000) * 1000;
const saved = { ...process.env };
let scratch: string;
let home: string;
const manifest = () => ({ ...loadManifests().find(m => m.name === 'claude-code')!, health: {
  installLocations: [], activityLocations: [{ kind: 'file' as const, path: path.join(scratch, 'sessions/{sessionId}.jsonl') }],
} });
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scoped-activity-')));
  Object.assign(process.env, sandboxChildEnv(scratch, { HOME: path.join(scratch, 'home') }));
  home = process.env.MYCO_HOME!;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(scratch, { recursive: true, force: true });
});
function native(id: string, at = NOW): void {
  for (const dir of [path.join(scratch, 'sessions'), path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects/fixture')]) {
    const file = path.join(dir, `${id}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'private contents are not identity evidence');
    fs.utimesSync(file, at / 1000, at / 1000);
  }
}
function route(url: string, id?: string, agent = 'claude-code', projectId = 'proj_same') {
  const entry = { version: REGISTRY_VERSION, root: path.join(scratch, new URL(url).hostname, projectId), serverUrl: url,
    projectId, token: 'A'.repeat(43), machineId: 'machine', joinedAt: 1, updatedAt: 1 };
  fs.mkdirSync(entry.root, { recursive: true });
  writeRegistryEntry(entry, { mycoHome: home });
  const spool = new MemberSpool(entry, { mycoHome: home });
  if (id) updateSessionState(spool.dir, id, state => { state.agent = agent; state.lastDeliveryAt = NOW - 2 * 86400000; });
  return { entry, spool };
}
it('attributes both directions using delivered state without journals and preserves old routes after rebind', () => {
  const a = route('https://a.example', A);
  route('https://b.example', B);
  native(A, NOW - 2 * 86400000); native(B);
  expect(a.spool.sessionIds()).toEqual([]);
  expect(a.spool.readSessionRoutes()).toEqual([{ sessionId: A, agent: 'claude-code' }]);
  const read = (url: string) => deploymentHarnessRanAt(manifest(), home, url, NOW);
  expect(read('https://a.example')).toBeUndefined(); expect(read('https://b.example')).toBe(NOW);
  native(A); native(B, NOW - 2 * 86400000);
  expect(read('https://a.example')).toBe(NOW); expect(read('https://b.example')).toBeUndefined();
  writeRegistryEntry({ ...a.entry, serverUrl: 'https://b.example' }, { mycoHome: home });
  expect(read('https://a.example')).toBe(NOW);
  expect(read('https://b.example')).toBeUndefined();
  expect(MEMBER_SESSION_STATE_RETENTION_MS).toBeGreaterThan(HARNESS_ACTIVITY_RETENTION_MS);
});
it('leaves wholly uncaptured sessions unassigned and excludes worker sessions and other agents', () => {
  route('https://a.example'); native(A);
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBeUndefined();
  route('https://a.example', A, 'codex');
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBeUndefined();
  route('https://a.example', A);
  new WorkerSessionEvidence(home).record('claude-code', A);
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBeUndefined();
});
it('drops cross-Deployment session conflicts and refuses unreadable state, destination and directory evidence', () => {
  const a = route('https://a.example', A); native(A);
  route('https://b.example', A);
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBeUndefined();
  fs.rmSync(path.join(home, 'member', 'spool'), { recursive: true });
  const rebuilt = route('https://a.example', A);
  fs.writeFileSync(path.join(rebuilt.spool.dir, `${A}.state.json`), '{', { mode: 0o600 });
  expect(() => deploymentHarnessRanAt(manifest(), home, a.entry.serverUrl, NOW)).toThrow('evidence');
  route('https://a.example', B);
  fs.writeFileSync(path.join(rebuilt.spool.dir, 'destination.json'), '{', { mode: 0o600 });
  expect(() => rebuilt.spool.readSessionRoutes()).toThrow();
  expect(() => deploymentHarnessRanAt(manifest(), home, a.entry.serverUrl, NOW)).toThrow('destinations');
  const spy = spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('unreadable'); });
  try { expect(() => deploymentHarnessRanAt(manifest(), home, a.entry.serverUrl, NOW)).toThrow(); } finally { spy.mockRestore(); }
});

for (const survivors of [1, 2]) it(`retained logout spools preserve scoped reports for ${survivors} surviving Deployments`, async () => {
  const routes = [route('https://a.example', A), ...(survivors === 2 ? [route('https://b.example', B)] : [])];
  const left = route('https://left.example', '33333333-3333-3333-3333-333333333333');
  native(A); native(B, NOW - 1000);
  for (const { spool } of routes) updateProjectContext(spool.dir, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE]; });
  const membership = readDeploymentMembership(left.entry.serverUrl, home)!;
  const bindings = logoutBindings(home).filter(entry => entry.serverUrl === left.entry.serverUrl);
  withRegistryLock(() => removeDeploymentForLogout(left.entry.serverUrl, membershipTokenDigest(membership), bindings, home), home);
  expect(fs.existsSync(path.join(left.spool.dir, 'destination.json'))).toBe(true);
  const seen: Array<{ url: string; body: any }> = [];
  await reportHarnesses({ serverUrl: routes[0].entry.serverUrl, ready: [], harnesses: [{ id: 'claude-code', provisioned: true, state: 'binary_missing', action: 'Install Claude Code again' }] }, home, Date.now() + 10000, {
    now: () => NOW, fetch: async (input, init) => { const body = JSON.parse(String(init?.body)); expect(parseProvisionedHarnessReport(body)).not.toBeNull(); seen.push({ url: String(input), body }); return Response.json({ persisted: true }); },
  });
  expect(seen).toHaveLength(survivors);
  for (const [i, route] of routes.entries()) expect(seen.find(report => report.url.startsWith(route.entry.serverUrl))!.body.harnesses[0]).toMatchObject({ state: 'binary_missing', activityScope: 'deployment', ranAt: NOW - i * 1000 });
});

it('merges Projects on one Deployment, ignores other agents and drops only an ambiguous session', () => {
  route('https://a.example', A, 'claude-code', 'proj_one');
  route('https://a.example/', A, 'claude-code', 'proj_two');
  const other = '33333333-3333-3333-3333-333333333333';
  route('https://a.example', other, 'codex', 'proj_codex');
  route('https://b.example', other, 'codex', 'proj_codex');
  route('https://b.example', B); native(A); native(B, NOW - 1000); native(other);
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBe(NOW);
  expect(deploymentHarnessRanAt(manifest(), home, 'https://b.example', NOW)).toBe(NOW - 1000);
  route('https://b.example', A, 'claude-code', 'proj_conflict');
  expect(deploymentHarnessRanAt(manifest(), home, 'https://a.example', NOW)).toBeUndefined();
  expect(deploymentHarnessRanAt(manifest(), home, 'https://b.example', NOW)).toBe(NOW - 1000);
});

it('treats state retired between listing and reading as absent', () => {
  const a = route('https://a.example', A); native(A);
  const read = fs.readdirSync;
  const spy = spyOn(fs, 'readdirSync').mockImplementation((...args: unknown[]) => {
    const names = Reflect.apply(read, fs, args);
    if (String(args[0]) === a.spool.dir) fs.rmSync(path.join(a.spool.dir, `${A}.state.json`), { force: true });
    return names;
  });
  try { expect(a.spool.readSessionRoutes()).toEqual([]); } finally { spy.mockRestore(); }
});

for (const damaged of ['binding', 'membership']) it(`reports valid Deployments despite an unrelated bad ${damaged} and keeps unacknowledged trust pending`, async () => {
  const a = route('https://a.example', A); const b = route('https://b.example', B);
  const bad = route('https://bad.example', '33333333-3333-3333-3333-333333333333');
  native(A); native(B, NOW - 1000);
  for (const { spool } of [a, b]) updateProjectContext(spool.dir, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE]; });
  updateProjectContext(bad.spool.dir, home, cache => { cache.features = []; cache.featuresAt = 1; });
  recordProvision(home, { serverUrl: a.entry.serverUrl, agents: ['codex'], version: 'test' });
  holdHookTrust(home, 'codex', 'Approve capture');
  const pendingTrust = readProvisionRecord(home)!.pendingTrust!;
  fs.writeFileSync(damaged === 'binding' ? registryEntryPath(bad.entry.root, home) : deploymentPath(bad.entry.serverUrl, home), '{', { mode: 0o600 });
  const seen: Array<{ url: string; body: any }> = [];
  await expect(reportHarnesses({ serverUrl: a.entry.serverUrl, ready: [], pendingTrust, harnesses: [
    { id: 'claude-code', provisioned: true, state: 'ready' },
    { id: 'codex', provisioned: true, state: 'trust_required', action: pendingTrust.codex.action, hookRepairAt: pendingTrust.codex.at },
  ] }, home, Date.now() + 10000, {
    now: () => NOW, fetch: async (input, init) => { const body = JSON.parse(String(init?.body)); expect(parseProvisionedHarnessReport(body)).not.toBeNull(); seen.push({ url: String(input), body }); return Response.json({ persisted: true }); },
  })).rejects.toThrow('project connections');
  expect(seen).toHaveLength(2);
  expect(seen.find(report => report.url.startsWith(a.entry.serverUrl))!.body.harnesses[0]).toMatchObject({ state: 'ready', activityScope: 'deployment', ranAt: NOW });
  expect(seen.find(report => report.url.startsWith(b.entry.serverUrl))!.body.harnesses[0]).toMatchObject({ state: 'repair_failed', activityScope: 'deployment', ranAt: NOW - 1000, action: expect.stringContaining('connection') });
  expect(readProvisionRecord(home)!.pendingTrust).toEqual(pendingTrust);
  seen.length = 0;
  fs.writeFileSync(path.join(b.spool.dir, `${B}.state.json`), '{');
  await expect(reportHarnesses({ serverUrl: a.entry.serverUrl, ready: [], harnesses: [{ id: 'claude-code', provisioned: true, state: 'ready' }] }, home, Date.now() + 10000, {
    now: () => NOW, fetch: async (input, init) => { const body = JSON.parse(String(init?.body)); expect(parseProvisionedHarnessReport(body)).not.toBeNull(); seen.push({ url: String(input), body }); return Response.json({ persisted: true }); },
  })).rejects.toThrow('project connections');
  const unavailable = seen.find(report => report.url.startsWith(b.entry.serverUrl))!.body.harnesses[0];
  expect(unavailable).toMatchObject({ state: 'repair_failed', activityScope: 'unavailable' });
  expect(unavailable.action).toContain('connection');
});
it('reports every live destination with its own activity, capability and deduplication', async () => {
  const a = route('https://a.example', A); const b = route('https://b.example', B);
  const real = loadManifests().find(m => m.name === 'claude-code')!;
  const nativeFile = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects/fixture', `${B}.jsonl`);
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true }); fs.writeFileSync(nativeFile, 'private');
  fs.utimesSync(nativeFile, NOW / 1000, NOW / 1000);
  for (const { spool } of [a, b]) updateProjectContext(spool.dir, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE]; });
  const seen: Array<{ url: string; body: any }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ persisted: true });
  };
  const result = { serverUrl: a.entry.serverUrl, ready: [], harnesses: [{ id: real.name, provisioned: true as const, state: 'ready' as const, ranAt: NOW }] };
  await reportHarnesses(result, home, Date.now() + 10000, { fetch, now: () => NOW });
  expect(seen).toHaveLength(2);
  const aFact = seen.find(report => report.url.startsWith(a.entry.serverUrl))!.body.harnesses[0];
  const bFact = seen.find(report => report.url.startsWith(b.entry.serverUrl))!.body.harnesses[0];
  expect(aFact).toMatchObject({ activityScope: 'deployment' });
  expect(aFact.ranAt).toBeUndefined();
  expect(bFact.ranAt).toBe(NOW);
  await reportHarnesses(result, home, Date.now() + 10000, { fetch, now: () => NOW });
  expect(seen).toHaveLength(2);
});

it('A-old/B-recent and the reverse reach independent health checks; known sessions still warn when capture stops', async () => {
  const rigs = [await memberRig(), await memberRig()];
  const routes = [route('https://a.example', A), route('https://b.example', B)];
  for (const [i, r] of rigs.entries()) {
    r.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [NOW]);
    r.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at)
      VALUES ('proj_1', 'old', 'machine_1', 'mt_test', ?, ?, 'claude-code', ?)`, [NOW - 2 * 86400000, NOW - 2 * 86400000, NOW - 2 * 86400000]);
    writeRegistryEntry({ ...routes[i].entry, token: r.token, machineId: 'machine_1' }, { mycoHome: home });
    updateProjectContext(routes[i].spool.dir, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE]; });
  }
  const file = (id: string, at: number) => {
    const name = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects/fixture', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, 'private'); fs.utimesSync(name, at / 1000, at / 1000);
  };
  const report = async () => {
    await reportHarnesses({ serverUrl: routes[0].entry.serverUrl, ready: [], harnesses: [{ id: 'claude-code', provisioned: true, state: 'ready' }] }, home, Date.now() + 10000, {
      now: () => NOW, fetch: async (input, init) => rigs[String(input).startsWith(routes[0].entry.serverUrl) ? 0 : 1].fetch(input, init),
    });
    return Promise.all(rigs.map(async r => (await readAttention(r.env.serverEnv, NOW)).items.filter(item => item.kind === 'harness_capture_silent')));
  };
  file(A, NOW - 2 * 86400000); file(B, NOW);
  const first = await report(); expect(first[0]).toEqual([]); expect(first[1]).toHaveLength(1);
  file(A, NOW); file(B, NOW - 2 * 86400000);
  const reverse = await report(); expect(reverse[0]).toHaveLength(1); expect(reverse[1]).toEqual([]);
});
