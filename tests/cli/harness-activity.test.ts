import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { loadManifests } from '@myco/symbionts/detect.js';
import { expandHome } from '@myco/paths/home.js';
import { harnessRanAt, reportHarnesses, keepCurrent } from '@myco/cli/member-keep-current.js';
import { WorkerSessionEvidence } from '@myco/symbionts/worker-session-evidence.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { withWorkerActivity } from '@myco/runner/drivers/worker-activity.js';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { listHarnessModels } from '@myco/runner/models.js';
import { provisionGlobally } from '@myco/cli/member.js';
import { attentionWords } from '../../packages/myco-server/ui/src/features/today/words.js';
import { HARNESS_SILENT_MS, HARNESS_ACTIVITY_RETENTION_MS, HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { memberRig } from '../member/helpers/server.js';

const USER = '11111111-1111-1111-1111-111111111111';
const WORKER = '22222222-2222-2222-2222-222222222222';
const NOW = Date.now();
const OLD = NOW - 2 * 24 * 60 * 60_000;
const RECENT = NOW - 60 * 60_000;
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
  if (manifest.name === 'cline') return manifest.health!.activityLocations.map((source) => source.path);
  expect(manifest.health!.activityLocations).toEqual([{ kind: 'file', path: '@transcripts' }]);
  const discovery = manifest.capture!.transcriptDiscovery!;
  return discovery.roots.flatMap((root) => discovery.patterns.map((pattern) => path.join(root, pattern)));
}

function recordPath(location: string, id: string): string {
  return expandHome(location).replaceAll('{sessionId}', id).replaceAll('rollout-*', 'rollout-2026-10-04').replaceAll('*_', '2026-10-04_').replaceAll('*', 'project');
}


function opencodeManifest(): SymbiontManifest { return loadManifests().find((m) => m.name === 'opencode')!; }

function opencodeFile(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/opencode.db');
}

function sessionStore(): Database {
  const file = opencodeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.run('PRAGMA foreign_keys = OFF');
  db.run(fs.readFileSync(new URL('../fixtures/opencode/session-schema.sql', import.meta.url), 'utf8'));
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA user_version = 1');
  return db;
}

function session(db: Database, id: string, at: number): void {
  db.run(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (?, 'fixture', 'fixture', '/fixture', 'private title', '1.18.21', ?, ?)
    ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`, [id, at, at]);
}

it('all nine manifests count session records and exclude worker identities without reading session contents', async () => {
  const manifests = loadManifests();
  expect(manifests).toHaveLength(9);
  for (const manifest of manifests) {
    expect(manifest.health?.activityLocations.length).toBeGreaterThan(0);
    if (manifest.name === 'opencode') {
      const db = sessionStore();
      try {
        session(db, USER, RECENT);
        session(db, WORKER, NOW);
        new WorkerSessionEvidence(mycoHome).record('opencode', WORKER);
        expect(harnessRanAt(manifest, mycoHome)).toBe(RECENT);
        session(db, USER, NOW + 1);
        expect(harnessRanAt(manifest, mycoHome)).toBe(NOW + 1);
      } finally { db.close(); }
      continue;
    }
    for (const location of recordLocations(manifest)) {
      expect(location).toContain('{sessionId}');
      const user = recordPath(location, USER);
      const worker = recordPath(location, WORKER);
      touch(user, RECENT);
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
        expect(harnessRanAt(manifest, mycoHome)).toBe(RECENT);
        expect(read.mock.calls.some(([target]) => target === user || target === worker)).toBe(false);
      } finally { read.mockRestore(); }
      touch(user, NOW + 1);
      expect(harnessRanAt(manifest, mycoHome)).toBe(NOW + 1);
      fs.unlinkSync(user);
      expect(harnessRanAt(manifest, mycoHome)).toBeUndefined();
    }
  }
});

it('shared database mtimes, caches, project metadata and session auxiliary files are not activity', () => {
  const db = sessionStore();
  for (const file of [
    '.local/share/opencode/cache.json', '.claude/projects/project/settings.json',
    '.cursor/projects/project/store.db', '.codex/sessions/cache.json',
    '.copilot/session-state/session/workspace.yaml', '.cline/data/tasks/session/task_metadata.json',
    '.gemini/antigravity/brain/session/task.md', '.codeium/windsurf/cascade/cache', '.pi/agent/sessions/project/cache',
  ]) touch(path.join(home, file), NOW);
  for (const manifest of loadManifests()) {
    expect(harnessRanAt(manifest, mycoHome)).toBeUndefined();
  }
  db.close();
});

it.skipIf(process.platform === 'win32')('OpenCode listings and runs use normal data and cache homes; worker sessions are excluded by id', async () => {
  process.env.XDG_DATA_HOME = path.join(home, 'data');
  process.env.XDG_CACHE_HOME = path.join(home, 'cache');
  const db = sessionStore();
  session(db, USER, RECENT);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const data = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const cache = process.env.XDG_CACHE_HOME || path.join(process.env.HOME, '.cache');
fs.mkdirSync(path.join(cache, 'opencode'), { recursive: true });
fs.writeFileSync(path.join(cache, 'opencode', 'models.json'), 'model cache');
const db = new Database(path.join(data, 'opencode/opencode.db'));
if (process.argv.includes('models')) {
  db.run('PRAGMA user_version = 1');
  db.close();
  console.log('openrouter/model');
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  let result = {};
  if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
  if (method === 'session/new') {
    db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'fixture', 'fixture', '/fixture', 'worker', '1.18.21', ?, ?)", ['${WORKER}', ${NOW}, ${NOW}]);
    result = { sessionId: '${WORKER}', configOptions: [{ id: 'mode', currentValue: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).default_agent }] };
  }
  if (method === 'session/prompt') result = { stopReason: 'end_turn' };
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  const runs = path.join(home, 'runs');
  expect(await listHarnessModels('opencode', runs, new AbortController().signal)).toMatchObject({ ok: true });
  expect(fs.readFileSync(path.join(home, 'cache/opencode/models.json'), 'utf8')).toBe('model cache');
  expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(RECENT);
  const launch = driverFor('opencode')!.launch({ scratchDir: runs, credentialEnv: {} });
  for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    expect(launch.env[key]).toBeUndefined();
    expect(launch.omitInherited).not.toContain(key);
  }
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const call = await request.json() as { id?: number; method: string };
    if (call.id === undefined) return new Response(null, { status: 202 });
    const result = call.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [] };
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  } });
  try {
    const mcpConfigPath = path.join(runs, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { myco: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp`, headers: {} } } }));
    const events = [];
    for await (const event of driverFor('opencode')!.run({ scratchDir: runs, mcpConfigPath, credentialEnv: {}, prompt: 'fixture' }, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({ kind: 'started', harness: 'opencode', sessionId: WORKER });
    expect(events.at(-1)).toMatchObject({ kind: 'ended', stop: 'end_turn' });
    expect(new WorkerSessionEvidence(mycoHome).has('opencode', WORKER)).toBe(true);
    expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(RECENT);
    expect(fs.existsSync(path.join(runs, 'opencode-home'))).toBe(false);
  } finally { void server.stop(true); db.close(); }
});

it('reads committed WAL session times under a writer lock without writing the database, WAL or shared-memory index', () => {
  const db = sessionStore();
  try {
    session(db, USER, RECENT);
    session(db, WORKER, NOW);
    new WorkerSessionEvidence(mycoHome).record('opencode', WORKER);
    db.run('BEGIN IMMEDIATE');
    session(db, USER, NOW + 1);
    const file = opencodeFile();
    const entries = fs.readdirSync(path.dirname(file));
    const before = [file, `${file}-wal`, `${file}-shm`].map((target) => fs.readFileSync(target));
    expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(RECENT);
    expect(fs.readdirSync(path.dirname(file))).toEqual(entries);
    expect([file, `${file}-wal`, `${file}-shm`].map((target) => fs.readFileSync(target))).toEqual(before);
    db.run('COMMIT');
    expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(NOW + 1);
  } finally { db.close(); }
});


it('read-only WAL activity never creates a missing shared-memory index', () => {
  const db = sessionStore();
  session(db, USER, RECENT);
  db.close();
  const dir = path.dirname(opencodeFile());
  const before = fs.readdirSync(dir);
  expect(before).not.toContain('opencode.db-shm');
  expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow();
  expect(fs.readdirSync(dir)).toEqual(before);
});

it('a contested ledger prune does not hide readable user activity', () => {
  const db = sessionStore();
  session(db, USER, NOW);
  const acquired = LifecycleLock.acquire(path.join(mycoHome, 'member/worker-sessions.lock'), { command: 'fixture writer' });
  expect(acquired.acquired).toBe(true);
  if (!acquired.acquired) throw new Error('fixture lock unavailable');
  try { expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(NOW); } finally { acquired.lock.release(); db.close(); }
});

it('an unresolved transcript-layout reference is unknown rather than idle', () => {
  const manifest = loadManifests().find((m) => m.name === 'claude-code')!;
  const invalid = { ...manifest, capture: { ...manifest.capture!, transcriptDiscovery: undefined } };
  expect(() => harnessRanAt(invalid, mycoHome)).toThrow('unavailable transcript layouts');
});

it('retains an exclusion for a run spanning the activity cutoff, and renews it when the run ends', async () => {
  const db = sessionStore();
  session(db, WORKER, NOW - HARNESS_SILENT_MS + 30 * 60_000);
  const ledger = new WorkerSessionEvidence(mycoHome);
  const driver = withWorkerActivity({ id: 'opencode', launch: () => ({ env: {}, omitInherited: [] }), async *run() {
    yield { kind: 'started' as const, harness: 'opencode', sessionId: WORKER };
    yield { kind: 'ended' as const, stop: 'end_turn' as const, detail: null };
  } });
  const run = driver.run({ scratchDir: home, mcpConfigPath: '', credentialEnv: {}, prompt: '' }, new AbortController().signal)[Symbol.asyncIterator]();
  try {
    await run.next();
    const dir = path.join(mycoHome, 'member/worker-sessions');
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    const began = NOW - HARNESS_SILENT_MS - 30 * 60_000;
    fs.utimesSync(file, began / 1000, began / 1000);
    expect(harnessRanAt(opencodeManifest(), mycoHome, NOW)).toBeUndefined();
    expect(ledger.has('opencode', WORKER)).toBe(true);
    await run.next();
    await run.next();
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(began);
  } finally { await run.return?.(); db.close(); }
});

it('a worker row created before the harness returns its identity cannot be reported as user activity', async () => {
  const db = sessionStore();
  let resume: (() => void) | undefined;
  let opened: (() => void) | undefined;
  const opening = new Promise<void>((resolve) => { opened = resolve; });
  const identity = new Promise<void>((resolve) => { resume = resolve; });
  const driver = withWorkerActivity({ id: 'opencode', launch: () => ({ env: {}, omitInherited: [] }), async *run() {
    session(db, WORKER, NOW);
    opened?.();
    await identity;
    yield { kind: 'started' as const, harness: 'opencode', sessionId: WORKER };
  } });
  const run = driver.run({ scratchDir: home, mcpConfigPath: '', credentialEnv: {}, prompt: '' }, new AbortController().signal)[Symbol.asyncIterator]();
  const started = run.next();
  await opening;
  try {
    expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('Worker session identity');
    resume?.();
    await started;
    expect(harnessRanAt(opencodeManifest(), mycoHome)).toBeUndefined();
    session(db, USER, NOW);
    expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(NOW);
  } finally { resume?.(); await run.return?.(); db.close(); }
});


it('the reader cannot repair an empty WAL index or write any session-store file', () => {
  const db = sessionStore();
  session(db, USER, RECENT);
  db.close();
  const file = opencodeFile();
  for (const suffix of ['-wal', '-shm']) fs.writeFileSync(`${file}${suffix}`, '');
  const before = [file, `${file}-wal`, `${file}-shm`].map((target) => fs.readFileSync(target));
  expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(RECENT);
  expect([file, `${file}-wal`, `${file}-shm`].map((target) => fs.readFileSync(target))).toEqual(before);
});

it('independent worker admissions coexist and the reader stays uncertain until every identity is recorded', () => {
  const ledger = new WorkerSessionEvidence(mycoHome);
  const first = ledger.begin('opencode');
  const second = ledger.begin('opencode');
  try {
    expect(ledger.starting('opencode')).toBe(true);
    first();
    expect(ledger.starting('opencode')).toBe(true);
  } finally { second(); }
  expect(ledger.starting('opencode')).toBe(false);
});

it('a worker admission beginning during the scan invalidates the activity snapshot even after it finishes', () => {
  const db = sessionStore();
  const ledger = new WorkerSessionEvidence(mycoHome);
  const source = opencodeManifest().health!.activityLocations[0]!;
  if (source.kind !== 'sqlite') throw new Error('SQLite source required');
  const query = Database.prototype.query;
  let inserted = false;
  const read = spyOn(Database.prototype, 'query').mockImplementation(function (sql, ...args) {
    if (sql === source.query && !inserted) {
      inserted = true;
      const release = ledger.begin('opencode');
      session(db, WORKER, NOW);
      ledger.record('opencode', WORKER);
      release();
    }
    return query.call(this, sql, ...args);
  });
  try { expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('changed during activity inspection'); } finally { read.mockRestore(); db.close(); }
});


async function heldFixture(body: string): Promise<{ exit: Promise<number | null> }> {
  const script = path.join(home, 'held-fixture.ts');
  fs.writeFileSync(script, body);
  const child = spawn(process.execPath, ['--no-env-file', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
  await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); child.once('exit', (code) => { if (code !== 0) reject(new Error(`fixture exited ${code}`)); }); });
  return { exit };
}

it('worker admission waits for a short activity probe without failing the run', async () => {
  const ledger = new WorkerSessionEvidence(mycoHome);
  ledger.begin('opencode')();
  const dir = path.join(mycoHome, 'member');
  const file = path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('worker-starting-') && name.endsWith('.lock'))!);
  const module = new URL('../../packages/myco/src/utils/lifecycle-lock.ts', import.meta.url).href;
  const { exit } = await heldFixture(`import { LifecycleLock } from ${JSON.stringify(module)};
const held = LifecycleLock.acquire(${JSON.stringify(file)});
if (!held.acquired) process.exit(2);
console.log('held');
setTimeout(() => { held.lock.release(); }, 100);
`);
  const release = ledger.begin('opencode');
  try { expect(ledger.starting('opencode')).toBe(true); } finally { release(); }
  expect(await exit).toBe(0);
});

it('concurrent marker writers serialize instead of failing a valid run', async () => {
  const module = new URL('../../packages/myco/src/utils/lifecycle-lock.ts', import.meta.url).href;
  const { exit } = await heldFixture(`import { LifecycleLock } from ${JSON.stringify(module)};
import path from 'node:path';
const held = LifecycleLock.acquire(path.join(process.env.MYCO_HOME!, 'member/worker-sessions.lock'));
if (!held.acquired) process.exit(2);
console.log('held');
setTimeout(() => { held.lock.release(); }, 100);
`);
  const ledger = new WorkerSessionEvidence(mycoHome);
  ledger.record('opencode', WORKER);
  expect(ledger.has('opencode', WORKER)).toBe(true);
  expect(await exit).toBe(0);
});

it('the busy timeout waits for a short external exclusive lock instead of reporting idle or failing immediately', async () => {
  const db = sessionStore();
  session(db, USER, RECENT);
  db.run('PRAGMA journal_mode = DELETE');
  db.close();
  const { exit } = await heldFixture(`import { Database } from 'bun:sqlite';
const db = new Database(${JSON.stringify(opencodeFile())});
db.run('BEGIN EXCLUSIVE');
console.log('held');
setTimeout(() => { db.run('ROLLBACK'); db.close(); }, 100);
`);
  expect(harnessRanAt(opencodeManifest(), mycoHome)).toBe(RECENT);
  expect(await exit).toBe(0);
});

it('missing, incompatible, locked and invalid SQLite activity is unknown, never idle', () => {
  expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow();
  expect(fs.existsSync(opencodeFile())).toBe(false);
  const db = sessionStore();
  try {
    db.run('ALTER TABLE session RENAME COLUMN time_updated TO changed_at');
    expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('no such column');
    db.run('DROP TABLE session');
    expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('no such table');
  } finally { db.close(); }
  const locked = new Database(opencodeFile());
  try {
    locked.run('PRAGMA journal_mode = DELETE');
    locked.run('CREATE TABLE session (id TEXT, time_updated INTEGER)');
    locked.run('BEGIN EXCLUSIVE');
    expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('locked');
    locked.run('ROLLBACK');
    locked.run("INSERT INTO session VALUES ('invalid', 'not a timestamp')");
    expect(() => harnessRanAt(opencodeManifest(), mycoHome)).toThrow('invalid identity or time');
  } finally { locked.close(); }
});

it('the SQLite connection refuses mutations even from an invalid source query', () => {
  const db = sessionStore();
  session(db, USER, RECENT);
  const manifest = opencodeManifest();
  const source = manifest.health!.activityLocations[0]!;
  expect(source.kind).toBe('sqlite');
  const invalid = { ...manifest, health: { ...manifest.health!, activityLocations: [{ ...source, query: 'UPDATE session SET time_updated = ? RETURNING id, time_updated AS ran_at' }] } };
  try {
    expect(() => harnessRanAt(invalid, mycoHome)).toThrow();
    expect(harnessRanAt(manifest, mycoHome)).toBe(RECENT);
  } finally { db.close(); }
});

it('prunes expired worker exclusions while retaining the silence window and margin; expired evidence cannot reappear', () => {
  const ledger = new WorkerSessionEvidence(mycoHome);
  ledger.record('opencode', 'expired');
  const dir = path.join(mycoHome, 'member/worker-sessions');
  const expired = path.join(dir, fs.readdirSync(dir)[0]!);
  ledger.record('opencode', 'boundary');
  const boundary = path.join(dir, fs.readdirSync(dir).find((name) => path.join(dir, name) !== expired)!);
  ledger.record('opencode', WORKER);
  const cutoff = NOW - HARNESS_ACTIVITY_RETENTION_MS;
  fs.utimesSync(expired, (cutoff - 1) / 1000, (cutoff - 1) / 1000);
  fs.utimesSync(boundary, cutoff / 1000, cutoff / 1000);
  fs.writeFileSync(path.join(dir, 'unrelated'), 'preserve');
  ledger.prune(NOW);
  expect(fs.existsSync(expired)).toBe(false);
  expect(fs.existsSync(boundary)).toBe(true);
  expect(fs.readdirSync(dir)).toHaveLength(3);
  const db = sessionStore();
  try {
    session(db, 'expired', cutoff - 1);
    expect(harnessRanAt(opencodeManifest(), mycoHome, NOW)).toBeUndefined();
    const manifest = loadManifests().find((m) => m.name === 'claude-code')!;
    touch(recordPath(recordLocations(manifest)[0]!, 'expired'), cutoff - 1);
    expect(harnessRanAt(manifest, mycoHome, NOW)).toBeUndefined();
  } finally { db.close(); }
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
  touch(user, RECENT);
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
  const db = sessionStore();
  session(db, WORKER, NOW);
  new WorkerSessionEvidence(mycoHome).record('opencode', WORKER);
  db.run('PRAGMA user_version = 1');
  const report = async () => {
    const ranAt = harnessRanAt(manifest, mycoHome);
    await reportHarnesses({ serverUrl: entry.serverUrl, ready: ['OpenCode'], harnesses: [{ id: 'opencode', provisioned: true, state: 'ready', ...(ranAt === undefined ? {} : { ranAt }) }] }, mycoHome, Date.now() + 10_000, { entry, fetch: rig.fetch });
    return (await readAttention(rig.env.serverEnv, NOW)).items.filter((item) => item.kind === 'harness_capture_silent');
  };
  expect(await report()).toEqual([]);
  session(db, USER, NOW);
  expect(await report()).toContainEqual(expect.objectContaining({ kind: 'harness_capture_silent', harness: 'opencode' }));
  db.close();
});


it('unreadable OpenCode activity reaches Health as cannot tell, and recovery restores the silence gate', async () => {
  const rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [NOW]);
  rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at)
    VALUES ('proj_1', 'captured', 'machine_1', 'mt_test', ?, ?, 'opencode', ?)`, [OLD, OLD, OLD]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: home, serverUrl: 'https://myco.example', token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome });
  updateProjectContext(spoolDirFor(entry.projectId, mycoHome), mycoHome, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  provisionGlobally('opencode', null, mycoHome, { serverUrl: entry.serverUrl });
  const result = keepCurrent(mycoHome, { binaryFound: () => true })!;
  expect(result.harnesses).toContainEqual(expect.objectContaining({ id: 'opencode', state: 'repair_failed', action: "Can't tell whether OpenCode ran; open it and check access to its session store" }));
  await reportHarnesses(result, mycoHome, Date.now() + 10_000, { entry, fetch: rig.fetch });
  const health = await readAttention(rig.env.serverEnv, NOW);
  const item = health.items.find((item) => item.kind === 'harness_needs_repair' && item.harness === 'opencode')!;
  expect(attentionWords(item, NOW, () => null).detail).toContain("Can't tell whether OpenCode ran");
  expect(health.items.some((item) => item.kind === 'harness_capture_silent')).toBe(false);
  const db = sessionStore();
  try {
    session(db, USER, NOW);
    const recovered = keepCurrent(mycoHome, { binaryFound: () => true })!;
    expect(recovered.harnesses).toContainEqual(expect.objectContaining({ id: 'opencode', state: 'ready', ranAt: NOW }));
    await reportHarnesses(recovered, mycoHome, Date.now() + 10_000, { entry, fetch: rig.fetch });
    expect((await readAttention(rig.env.serverEnv, NOW)).items).toContainEqual(expect.objectContaining({ kind: 'harness_capture_silent', harness: 'opencode' }));
  } finally { db.close(); }
});
