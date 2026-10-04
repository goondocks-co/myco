import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { opencodeLaunchHome } from '@myco/runner/drivers/opencode.js';
import { harnessById } from '@myco/runner/harnesses.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { expandHome } from '@myco/paths/home.js';
import { harnessRanAt, reportHarnesses } from '@myco/cli/member-keep-current.js';
import { WorkerSessionEvidence } from '@myco/symbionts/worker-session-evidence.js';
import { withWorkerActivity } from '@myco/runner/drivers/worker-activity.js';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { listHarnessModels } from '@myco/runner/models.js';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { memberRig } from '../member/helpers/server.js';

const USER = '11111111-1111-1111-1111-111111111111';
const WORKER = '22222222-2222-2222-2222-222222222222';
const OLD = 1_800_000_000_000;
const NOW = OLD + 2 * 24 * 60 * 60_000;
let home: string;
let mycoHome: string;
const keys = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'MYCO_HOME', 'PATH', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-activity-'));
  mycoHome = path.join(home, 'myco');
  process.env.HOME = home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.MYCO_HOME = mycoHome;
  for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete process.env[key];
});
afterEach(() => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  fs.rmSync(home, { recursive: true, force: true });
});

function touch(file: string, at: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'private session contents');
  fs.utimesSync(file, at / 1000, at / 1000);
}

function recordLocations(manifest: SymbiontManifest): string[] {
  if (manifest.name === 'opencode' || manifest.name === 'cline') return manifest.health!.activityLocations;
  expect(manifest.health!.activityLocations).toEqual(['@transcripts']);
  const discovery = manifest.capture!.transcriptDiscovery!;
  return discovery.roots.flatMap((root) => discovery.patterns.map((pattern) => path.join(root, pattern)));
}

function recordPath(location: string, id: string): string {
  return expandHome(location).replaceAll('{sessionId}', id).replaceAll('rollout-*', 'rollout-2026-10-04').replaceAll('*_', '2026-10-04_').replaceAll('*', 'project');
}

it('all nine manifests count session records and exclude worker identities without reading session contents', async () => {
  const manifests = loadManifests();
  expect(manifests).toHaveLength(9);
  for (const manifest of manifests) {
    expect(manifest.health?.activityLocations.length).toBeGreaterThan(0);
    for (const location of recordLocations(manifest)) {
      expect(location).toContain('{sessionId}');
      const user = recordPath(location, USER);
      const worker = recordPath(location, WORKER);
      touch(user, OLD);
      touch(worker, NOW);
      const driver = withWorkerActivity({ id: manifest.name, launch: () => ({ env: {}, omitInherited: [] }), async *run() {
        yield { kind: 'started' as const, harness: manifest.name, sessionId: WORKER };
        throw new Error('worker crashed');
      } });
      const run = driver.run({ scratchDir: home, mcpConfigPath: '', credentialEnv: {}, prompt: '' }, new AbortController().signal)[Symbol.asyncIterator]();
      await run.next();
      expect(new WorkerSessionEvidence(mycoHome).has(manifest.name, WORKER)).toBe(true);
      await expect(run.next()).rejects.toThrow('worker crashed');
      const read = spyOn(fs, 'readFileSync');
      try {
        expect(harnessRanAt(manifest, mycoHome)).toBe(OLD);
        expect(read.mock.calls.some(([target]) => target === user || target === worker)).toBe(false);
      } finally { read.mockRestore(); }
      touch(user, NOW + 1);
      expect(harnessRanAt(manifest, mycoHome)).toBe(NOW + 1);
      fs.unlinkSync(user);
      expect(harnessRanAt(manifest, mycoHome)).toBeUndefined();
    }
  }
});

it('shared databases, caches, project metadata and session auxiliary files are not activity', () => {
  for (const file of [
    '.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal',
    '.local/share/opencode/cache.json', '.claude/projects/project/settings.json',
    '.cursor/projects/project/store.db', '.codex/sessions/cache.json',
    '.copilot/session-state/session/workspace.yaml', '.cline/data/tasks/session/task_metadata.json',
    '.gemini/antigravity/brain/session/task.md', '.codeium/windsurf/cascade/cache', '.pi/agent/sessions/project/cache',
  ]) touch(path.join(home, file), NOW);
  for (const manifest of loadManifests()) {
    expect(harnessRanAt(manifest, mycoHome)).toBeUndefined();
  }
});

it.skipIf(process.platform === 'win32')('OpenCode listings and runs get private data/cache/state through the same launch path', async () => {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nmkdir -p "$XDG_DATA_HOME/opencode/storage/session/global" "$XDG_CACHE_HOME/opencode" "$XDG_STATE_HOME/opencode"\nprintf '{}' > "$XDG_DATA_HOME/opencode/opencode.db"\nprintf '{}' > "$XDG_DATA_HOME/opencode/storage/session/global/listing.json"\nprintf '%s\\n' openrouter/model\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  const manifest = loadManifests().find((m) => m.name === 'opencode')!;
  const legacyUser = recordPath(recordLocations(manifest)[0]!, USER);
  touch(legacyUser, OLD);
  const runs = path.join(home, 'runs');
  expect(await listHarnessModels('opencode', runs, new AbortController().signal)).toMatchObject({ ok: true });
  expect(fs.readdirSync(runs)).toEqual([]);
  expect(harnessRanAt(manifest, mycoHome)).toBe(OLD);
  process.env.XDG_DATA_HOME = path.join(home, 'custom-data');
  const login = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  touch(login, OLD);
  const launch = driverFor('opencode')!.launch({ scratchDir: runs, credentialEnv: {} });
  expect(launch.env.XDG_DATA_HOME).not.toBe(process.env.XDG_DATA_HOME);
  expect(fs.readlinkSync(path.join(launch.env.XDG_DATA_HOME!, 'opencode', 'auth.json'))).toBe(login);
  for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) expect(launch.env[key]).toStartWith(runs);
  const customLogin = path.join(home, 'custom-login.json');
  touch(customLogin, OLD);
  const custom = opencodeLaunchHome(runs, { ...harnessById('opencode')!, credential: { kind: 'file', path: customLogin, requires: [] } });
  expect(fs.readlinkSync(path.join(custom.XDG_DATA_HOME!, 'opencode', 'auth.json'))).toBe(customLogin);
  touch(path.join(launch.env.XDG_DATA_HOME!, 'opencode', 'storage', 'session', 'global', `${WORKER}.json`), NOW);
  expect(harnessRanAt(manifest, mycoHome)).toBe(OLD);
});

it.skipIf(process.platform === 'win32')('the registered worker driver records its session before the caller receives it', async () => {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${WORKER}"}' '{"type":"result","stop_reason":"end_turn"}'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  const spec = { scratchDir: home, mcpConfigPath: path.join(home, 'mcp.json'), credentialEnv: {}, prompt: 'test' };
  const events = [];
  for await (const event of driverFor('claude-code')!.run(spec, new AbortController().signal)) {
    if (event.kind === 'started') expect(new WorkerSessionEvidence(mycoHome).has('claude-code', WORKER)).toBe(true);
    events.push(event);
  }
  expect(events).toContainEqual({ kind: 'started', harness: 'claude-code', sessionId: WORKER });
});

it('records a worker session that fails admission before a started event', async () => {
  const driver = withWorkerActivity({ id: 'cursor', launch: () => ({ env: {}, omitInherited: [] }), async *run(spec) {
    spec.sessionOpened?.(WORKER);
    yield { kind: 'ended' as const, stop: 'error' as const, detail: 'session_unasked' };
  } });
  for await (const event of driver.run({ scratchDir: home, mcpConfigPath: '', credentialEnv: {}, prompt: '' }, new AbortController().signal)) {
    expect(event.kind).toBe('ended');
    expect(new WorkerSessionEvidence(mycoHome).has('cursor', WORKER)).toBe(true);
  }
});

it.skipIf(process.platform === 'win32')('unreadable session evidence surfaces an error and symlinked records do not count', () => {
  const manifest = loadManifests().find((m) => m.name === 'claude-code')!;
  const user = recordPath(recordLocations(manifest)[0]!, USER);
  touch(user, OLD);
  const readdir = spyOn(fs, 'readdirSync');
  readdir.mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); });
  try { expect(() => harnessRanAt(manifest, mycoHome)).toThrow('unreadable'); } finally { readdir.mockRestore(); }
  const lstat = fs.lstatSync;
  const stat = spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (file === user) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return lstat(file, ...args);
  });
  try { expect(harnessRanAt(manifest, mycoHome)).toBeUndefined(); } finally { stat.mockRestore(); }
  fs.unlinkSync(user);
  const elsewhere = path.join(home, 'elsewhere');
  touch(elsewhere, NOW);
  fs.symlinkSync(elsewhere, user);
  expect(harnessRanAt(manifest, mycoHome)).toBeUndefined();
});

it('worker records and model-listing database writes stay quiet through the real report route; an uncaptured user session warns', async () => {
  const rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [NOW]);
  rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at)
    VALUES ('proj_1', 'captured', 'machine_1', 'mt_test', ?, ?, 'opencode', ?)`, [OLD, OLD, OLD]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: home, serverUrl: 'https://myco.example', token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome });
  updateProjectContext(spoolDirFor(entry.projectId, mycoHome), mycoHome, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  const manifest = loadManifests().find((m) => m.name === 'opencode')!;
  touch(recordPath(recordLocations(manifest)[0]!, WORKER), NOW);
  new WorkerSessionEvidence(mycoHome).record('opencode', WORKER);
  touch(path.join(home, '.local/share/opencode/opencode.db-wal'), NOW);
  const report = async () => {
    const ranAt = harnessRanAt(manifest, mycoHome);
    await reportHarnesses({ serverUrl: entry.serverUrl, ready: ['OpenCode'], harnesses: [{ id: 'opencode', provisioned: true, state: 'ready', ...(ranAt === undefined ? {} : { ranAt }) }] }, mycoHome, Date.now() + 10_000, { entry, fetch: rig.fetch });
    return (await readAttention(rig.env.serverEnv, NOW)).items.filter((item) => item.kind === 'harness_capture_silent');
  };
  expect(await report()).toEqual([]);
  touch(recordPath(recordLocations(manifest)[0]!, USER), NOW);
  expect(await report()).toContainEqual(expect.objectContaining({ kind: 'harness_capture_silent', harness: 'opencode' }));
});
