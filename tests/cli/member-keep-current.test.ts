import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { provisionGlobally } from '@myco/cli/member.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { keepCurrent, reportHarnesses } from '@myco/cli/member-keep-current.js';
import { readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { PROTOCOL_HEADER, MEMBER_PROTOCOL } from '@goondocks/myco-shared/member-protocol';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { run as update } from '@myco/cli/update.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { memberRig } from '../member/helpers/server.js';
import { readAttention } from '@myco-server-worker/core/attention.js';

const SERVER = 'https://myco.example';
let home: string;
let agentHome: string;
const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME, PATH: process.env.PATH };
const hooks = () => path.join(agentHome, '.codex', 'hooks.json');
const config = () => path.join(agentHome, '.codex', 'config.toml');
beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-keep-current-'));
  home = path.join(agentHome, 'myco');
  process.env.HOME = agentHome;
  process.env.MYCO_HOME = home;
  const bin = path.join(agentHome, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const binary of ['codex', 'claude']) fs.writeFileSync(path.join(bin, binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(agentHome, { recursive: true, force: true });
});

it('records every harness at the shared provisioning operation, including unchanged installs', () => {
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] });
  for (const agent of ['codex', 'claude-code']) provisionGlobally(agent, null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
});

it('the next CLI helper pass restores deleted hooks and MCP byte for byte and preserves unrelated config', async () => {
  fs.mkdirSync(path.dirname(config()), { recursive: true });
  fs.writeFileSync(config(), 'model = "personal-model"\n\n[features]\nhooks = true\n\n[mcp_servers.other]\ncommand = "other"\n');
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const originalHooks = fs.readFileSync(hooks(), 'utf8');
  const originalConfig = fs.readFileSync(config(), 'utf8');
  fs.unlinkSync(hooks());
  fs.writeFileSync(config(), originalConfig.slice(0, originalConfig.indexOf('[mcp_servers.myco]')));
  await runHelperVerb(['--project', 'proj_test', '--home', home, '--stderr'], { pass: async () => {}, lingerMs: 0 });
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(originalHooks);
  expect(fs.readFileSync(config(), 'utf8')).toBe(originalConfig);
  expect(parseToml(originalConfig)).toMatchObject({ model: 'personal-model', mcp_servers: { other: { command: 'other' } } });
});

it('backfills an empty record from surviving owned MCP registration and repairs hooks on update', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const original = fs.readFileSync(hooks(), 'utf8');
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] }, { replace: true });
  fs.unlinkSync(hooks());
  await update([]);
  expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(original);
});

it('update runs the same repair and leaves a healthy setup byte for byte unchanged', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const original = fs.readFileSync(hooks(), 'utf8');
  const healthyRecord = fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8');
  const healthyMtime = fs.statSync(hooks()).mtimeMs;
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('ready');
  expect(fs.statSync(hooks()).mtimeMs).toBe(healthyMtime);
  expect(fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8')).toBe(healthyRecord);
  fs.unlinkSync(hooks());
  await update([]);
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(original);
  const record = fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8');
  const modified = fs.statSync(hooks()).mtimeMs;
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses).toEqual([{ id: 'codex', provisioned: true, state: 'trust_required', action: "Restart Codex and trust Myco's hooks" }]);
  expect(fs.statSync(hooks()).mtimeMs).toBe(modified);
  expect(fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8')).toBe(record);
});

it.skipIf(process.platform === 'win32')('reports a removed binary, an unwritable config and renewed hook trust, keeping every harness recorded', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(keepCurrent(home, { binaryFound: () => false })?.harnesses[0]).toMatchObject({ state: 'binary_missing', action: 'Install Codex again' });
  fs.unlinkSync(hooks());
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0]).toMatchObject({ state: 'trust_required', action: "Restart Codex and trust Myco's hooks" });
  fs.unlinkSync(config());
  fs.chmodSync(path.dirname(config()), 0o500);
  try {
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0]).toMatchObject({ state: 'unwritable', action: "Allow Myco to write Codex's configuration" });
    expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
  } finally { fs.chmodSync(path.dirname(config()), 0o700); }
});

it('never overwrites unreadable user config and retries a failed repair without forgetting the harness', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(config(), 'invalid TOML [');
  expect(keepCurrent(home)?.harnesses[0].state).toBe('repair_failed');
  expect(fs.readFileSync(config(), 'utf8')).toBe('invalid TOML [');
  expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
});

it('repairs stale hooks and MCP from the recorded binary when the current runtime pin moves', () => {
  const oldBinary = path.join(home, 'bin', 'myco-old');
  const newBinary = path.join(home, 'bin', 'myco-new');
  fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
  for (const binary of [oldBinary, newBinary]) fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'runtime.command'), `${oldBinary}\n`);
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(path.join(home, 'runtime.command'), `${newBinary}\n`);
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('trust_required');
  expect(fs.readFileSync(hooks(), 'utf8')).toContain(newBinary);
  expect(fs.readFileSync(hooks(), 'utf8')).not.toContain(oldBinary);
  expect(fs.readFileSync(config(), 'utf8')).toContain(newBinary);
  expect(readProvisionRecord(home)?.binaries?.codex).toBe(newBinary);
});

it('doctor names missing hooks or MCP without writing any configuration', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(setupChecks(home)[0].status).toBe('ok');
  fs.unlinkSync(hooks());
  expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('hooks or MCP entry are missing or stale') });
  expect(fs.existsSync(hooks())).toBe(false);
  keepCurrent(home, { binaryFound: () => true });
  fs.writeFileSync(config(), '[features]\nhooks = true\n');
  expect(setupChecks(home)[0].status).toBe('warn');
  expect(fs.readFileSync(config(), 'utf8')).not.toContain('[mcp_servers.myco]');
});

it('reports repair status only after the Deployment advertises the feature', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_test', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  const report = { serverUrl: SERVER, ready: [], harnesses: [{ id: 'codex', provisioned: true as const, state: 'binary_missing' as const, action: 'Install Codex again' }] };
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
  };
  await reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  expect(requests).toHaveLength(0);
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/members/harnesses/report');
  expect(await requests[0]!.json()).toEqual({ harnesses: report.harnesses });
});

it('an unrepairable helper pass reaches Deployment Health through the real report route', async () => {
  const rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [Date.now()]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(config(), 'invalid TOML [');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await runHelperVerb(['--project', entry.projectId, '--home', home, '--stderr'], { fetch: rig.fetch, lingerMs: 0 });
  expect((await readAttention(rig.env.serverEnv, Date.now())).items).toContainEqual(expect.objectContaining({
    kind: 'harness_needs_repair', machineId: 'machine_1', harness: 'codex', state: 'repair_failed', action: 'Run myco member provision codex to see what needs fixing',
  }));
  expect(fs.readFileSync(config(), 'utf8')).toBe('invalid TOML [');
});

it('retains a trust action through offline reporting, then clears the local hold only on accepted delivery', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.unlinkSync(hooks());
  const repaired = keepCurrent(home, { binaryFound: () => true });
  expect(repaired?.harnesses[0].state).toBe('trust_required');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(repaired, home, Date.now() + 10_000, { entry, fetch: async () => { throw new Error('offline'); } });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('trust_required');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(repaired, home, Date.now() + 10_000, { entry, fetch: async () => Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } }) });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('ready');
});
