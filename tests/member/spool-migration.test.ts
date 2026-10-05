import { drainEntryBacklog } from '@myco/member/backlog.js';
import { warmProjectContext } from '@myco/member/prefetch.js';
import { readProjectContext } from '@myco/member/context-cache.js';
import { listRoutingEntries } from '@myco/member/routing.js';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHook } from './helpers/hooks.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { removeRegistryEntry, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { assignLegacySpoolDestination, migrateLegacySpool, pinLegacySpoolDestination, pinLegacySpoolDestinationForProject, legacySpoolDir, LEGACY_MIGRATION_FILE, listLegacySpools, listRetiredLegacySpoolDirs, LEGACY_SPOOL_RETIRE_GRACE_MS } from '@myco/member/spool-migration.js';
import { bufferLockPath, readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { behindTranscriptPaths, pruneDeliveredSessionState, prunePluginTranscripts } from '@myco/member/retention.js';
import { ServerClient } from '@myco/member/transport.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { REFUSED_LOG_MAX_BYTES } from '@myco/member/constants.js';
import { CaptureLossLedger } from '@myco/member/capture-loss.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { memberRig } from './helpers/server.js';

const projectId = 'proj_1647';
const routeA = { serverUrl: 'https://alpha.example', projectId };
const routeB = { serverUrl: 'https://beta.example', projectId };
const envNames = ['HOME', 'MYCO_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PATH'] as const;
let saved: Record<string, string | undefined>;
let scratch: string;
let mycoHome: string;

beforeEach(() => {
  saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  scratch = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spool-migration-')));
  mycoHome = path.join(scratch, 'myco');
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const) {
    process.env[name] = path.join(scratch, name.toLowerCase());
    fs.mkdirSync(process.env[name]!, { recursive: true });
  }
  process.env.MYCO_HOME = mycoHome;
  process.env.PATH = '/usr/bin:/bin';
});

afterEach(() => {
  for (const name of envNames) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

function binding(serverUrl: string, root = path.join(scratch, 'repo')): RegistryEntry {
  return { version: 2, root, projectId, serverUrl, token: 'scratch-token', machineId: 'scratch-machine', joinedAt: 1, updatedAt: 1 };
}

function legacy(): MemberSpool {
  return new MemberSpool(null, { dir: legacySpoolDir(projectId, mycoHome), mycoHome });
}

function appendPrompt(spool: MemberSpool, sessionId: string, text: string): string {
  const event = promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 'test' }, { promptId: mintId(), text });
  spool.append(sessionId, event);
  return event.envelope.eventId;
}

describe('legacy member spool migration', () => {
  it('holds capture when the Project has no unique Deployment binding', () => {
    const source = legacy();
    appendPrompt(source, 'session-one', 'held');
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool has no unique Deployment binding' });
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    writeRegistryEntry(binding(routeB.serverUrl, path.join(scratch, 'other')), { mycoHome });
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool has no unique Deployment binding' });
    expect(source.readRecords('session-one')).toHaveLength(1);
    expect(listLegacySpools(mycoHome)).toMatchObject([{ projectId, status: 'held', records: 1 }]);
  });

  it('pins the original Deployment before a binding is replaced', () => {
    writeRegistryEntry(binding(`${routeA.serverUrl}/`), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'session-one', 'original');
    expect(pinLegacySpoolDestination(binding(routeA.serverUrl), mycoHome)).toMatchObject({ status: 'pinned', destination: routeA });
    writeRegistryEntry(binding(routeB.serverUrl), { mycoHome });
    expect(listRoutingEntries(mycoHome).map((entry) => entry.serverUrl).sort()).toEqual([routeA.serverUrl, routeB.serverUrl]);
    expect(new MemberSpool(routeA, { mycoHome }).readRecords('session-one')).toHaveLength(0);
    expect(source.readRecords('session-one')).toHaveLength(1);
    expect(migrateLegacySpool(routeB, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool is pinned to another Deployment' });
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', records: 1, copied: 1 });
    expect(new MemberSpool(routeA, { mycoHome }).readRecords('session-one')).toHaveLength(1);
    expect(new MemberSpool(routeB, { mycoHome }).readRecords('session-one')).toHaveLength(0);
  });

  it('copies the unacknowledged tail, staged bytes, receipts, and a concurrent target record once', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    const target = new MemberSpool(routeA, { mycoHome });
    const old = appendPrompt(source, 'session-two', 'already acknowledged');
    const pending = appendPrompt(source, 'session-two', 'x'.repeat(REFUSED_LOG_MAX_BYTES));
    const current = appendPrompt(target, 'session-two', 'current capture');
    updateSessionState(source.dir, 'session-two', (state) => {
      state.highWater = 1;
      state.prompts['old-hash'] = 'old-prompt';
    });
    const original = fs.readFileSync(path.join(source.dir, 'session-two.jsonl'));
    const first = migrateLegacySpool(routeA, mycoHome);
    expect(first).toMatchObject({ status: 'migrated', sessions: 1, records: 1, copied: 1 });
    expect(fs.readFileSync(path.join(source.dir, 'session-two.jsonl'))).toEqual(original);
    const records = target.readRecords('session-two');
    expect(records.map((record) => record?.eventId)).toEqual([current, pending]);
    expect(records.map((record) => record?.eventId)).not.toContain(old);
    expect(records[1]?._blobSource?.path.startsWith(target.blobsDirFor('session-two'))).toBe(true);
    expect(fs.readFileSync(records[1]!._blobSource!.path).byteLength).toBeGreaterThan(0);
    expect(readSessionState(target.dir, 'session-two').prompts['old-hash']).toBe('old-prompt');
    expect(JSON.parse(fs.readFileSync(path.join(target.dir, LEGACY_MIGRATION_FILE), 'utf8')).state).toBe('validated');
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    expect(target.readRecords('session-two').map((record) => record?.eventId)).toEqual([current, pending]);
  });

  it('recovers a copied journal whose per-session receipt was interrupted', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    const id = appendPrompt(source, 'session-three', 'retry');
    const target = new MemberSpool(routeA, { mycoHome });
    const record = source.readRecords('session-three')[0]!;
    fs.writeFileSync(path.join(target.dir, 'session-three.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(target.dir, LEGACY_MIGRATION_FILE), JSON.stringify({ version: 1, state: 'copying' }), { mode: 0o600 });
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    expect(target.readRecords('session-three').map((row) => row?.eventId)).toEqual([id]);
  });

  it('holds when a copied unacknowledged event disappears from the destination', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'session-lost', 'pending');
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    const target = new MemberSpool(routeA, { mycoHome });
    fs.unlinkSync(path.join(target.dir, 'session-lost.jsonl'));
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Previously copied event lacks delivery evidence: session-lost' });
  });

  it('accepts a real drain receipt even after ordinary session state retention', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'session-delivered', 'delivered');
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    const target = new MemberSpool(routeA, { mycoHome });
    const client = new ServerClient({ serverUrl: routeA.serverUrl, token: rig.token, projectId }, rig.fetch);
    expect(await target.drainSession('session-delivered', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    expect(fs.existsSync(path.join(target.dir, 'session-delivered.jsonl'))).toBe(false);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    pruneDeliveredSessionState(target, Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(fs.existsSync(path.join(target.dir, 'session-delivered.state.json'))).toBe(false);
    expect(fs.existsSync(path.join(target.dir, '.session-delivered.migration-settled.json'))).toBe(true);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
  });

  it('retains old plugin transcripts pointed to by routed and legacy session state', () => {
    const oldSpool = legacy();
    const newSpool = new MemberSpool(routeA, { mycoHome });
    const root = path.join(mycoHome, 'member', 'transcripts', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    const oldFile = path.join(root, 'legacy.jsonl');
    const newFile = path.join(root, 'routed.jsonl');
    for (const file of [oldFile, newFile]) fs.writeFileSync(file, '{"type":"user"}\n');
    updateSessionState(oldSpool.dir, 'legacy-session', (state) => { state.transcript = transcriptPointerFor(oldFile, 'machine_1')!; });
    updateSessionState(newSpool.dir, 'routed-session', (state) => { state.transcript = transcriptPointerFor(newFile, 'machine_1')!; });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    for (const file of [oldFile, newFile]) fs.utimesSync(file, old, old);
    expect(behindTranscriptPaths(mycoHome)).toEqual(new Set([path.resolve(oldFile), path.resolve(newFile)]));
    expect(prunePluginTranscripts(Date.now(), process.env, mycoHome)).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('stops transcript pruning if a spool state is unreadable', () => {
    const source = legacy();
    const root = path.join(mycoHome, 'member', 'transcripts', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'held.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n');
    fs.utimesSync(file, new Date(0), new Date(0));
    fs.writeFileSync(path.join(source.dir, 'broken.state.json'), 'not json', { mode: 0o600 });
    expect(() => prunePluginTranscripts(Date.now(), process.env, mycoHome)).toThrow(/Spool session state is malformed/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('holds a session being drained from its legacy location', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'session-four', 'held while draining');
    const lease = LifecycleLock.acquire(path.join(source.dir, '.session-four.drain.lock'), { command: 'test' });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;
    try {
      expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy session is draining: session-four' });
      expect(new MemberSpool(routeA, { mycoHome }).readRecords('session-four')).toEqual([]);
    } finally { lease.lock.release(); }
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
  });

  it('does not list Deployment-key directories as legacy Project spools', () => {
    const scoped = new MemberSpool(routeA, { mycoHome });
    appendPrompt(scoped, 'session-current', 'current');
    expect(listLegacySpools(mycoHome)).toEqual([]);
  });

  it('keeps an ambiguous legacy spool held after one binding is removed', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    writeRegistryEntry(binding(routeB.serverUrl, path.join(scratch, 'other')), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'session-ambiguous', 'do not guess');
    expect(pinLegacySpoolDestinationForProject(projectId, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool has no unique Deployment binding' });
    removeRegistryEntry(path.join(scratch, 'other'), mycoHome);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool has no unique Deployment binding' });
    expect(new MemberSpool(routeA, { mycoHome }).readRecords('session-ambiguous')).toEqual([]);
  });

  it('uses an explicit assignment to release an ambiguous spool without erasing its hold audit', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    writeRegistryEntry(binding(routeB.serverUrl, path.join(scratch, 'other')), { mycoHome });
    const source = legacy();
    const eventId = appendPrompt(source, 'session-assigned', 'chosen destination');
    expect(pinLegacySpoolDestinationForProject(projectId, mycoHome).status).toBe('held');
    const audit = fs.readFileSync(path.join(source.dir, '.legacy-routing-hold.json'));
    expect(assignLegacySpoolDestination(routeA, mycoHome)).toMatchObject({ status: 'assigned', destination: routeA, sessions: 1, records: 1 });
    expect(fs.readFileSync(path.join(source.dir, '.legacy-routing-hold.json'))).toEqual(audit);
    expect(assignLegacySpoolDestination(routeB, mycoHome)).toMatchObject({ status: 'held', destination: routeA, reason: 'Legacy spool is pinned to another Deployment' });
    expect(migrateLegacySpool(routeB, mycoHome).status).toBe('held');
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    expect(new MemberSpool(routeA, { mycoHome }).readRecords('session-assigned')[0]?.eventId).toBe(eventId);
  });

  it('reports an unreadable legacy entry as held instead of omitting it', () => {
    const root = path.dirname(legacySpoolDir(projectId, mycoHome));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, projectId), 'not a directory', { mode: 0o600 });
    expect(listLegacySpools(mycoHome)).toMatchObject([{ projectId, status: 'held', reason: 'Legacy spool is unreadable' }]);
  });

  it('moves legacy context and diagnostics while preserving an existing scoped project cache', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    const target = new MemberSpool(routeA, { mycoHome });
    appendPrompt(source, 'session-sidecars', 'capture');
    const sourceContext = path.join(source.dir, 'context');
    const targetContext = path.join(target.dir, 'context');
    fs.mkdirSync(sourceContext, { mode: 0o700 });
    fs.mkdirSync(targetContext, { mode: 0o700 });
    const oldProject = `${JSON.stringify({ version: 1, features: [], featuresAt: 1, blocks: { start: { context: 'old', at: 1 } } })}\n`;
    const currentProject = `${JSON.stringify({ version: 1, features: [], featuresAt: 2, blocks: { start: { context: 'current', at: 2 } } })}\n`;
    fs.writeFileSync(path.join(sourceContext, 'project.json'), oldProject, { mode: 0o600 });
    fs.writeFileSync(path.join(targetContext, 'project.json'), currentProject, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceContext, 'session-sidecars.json'), `${JSON.stringify({ version: 1, prompt: { context: 'served', promptId: 'prompt-id', at: 1 } })}\n`, { mode: 0o600 });
    source.markOffline(100);
    source.appendRefused({ eventId: 'old', sessionId: 'session-sidecars', kind: 'prompt', code: 'refused', reason: 'old refusal', at: 1 });
    target.appendRefused({ eventId: 'current', sessionId: 'session-sidecars', kind: 'prompt', code: 'refused', reason: 'current refusal', at: 2 });
    const originalContext = fs.readFileSync(path.join(sourceContext, 'project.json'));
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    expect(fs.readFileSync(path.join(targetContext, 'project.json'), 'utf8')).toBe(currentProject);
    expect(fs.readFileSync(path.join(targetContext, 'session-sidecars.json'), 'utf8')).toContain('served');
    expect(target.readLatch()).toMatchObject({ since: 100 });
    expect(target.readRefused().entries.map((entry) => entry.eventId)).toEqual(['current', 'old']);
    expect(fs.readFileSync(path.join(sourceContext, 'project.json'))).toEqual(originalContext);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    expect(target.readRefused().entries.map((entry) => entry.eventId)).toEqual(['current', 'old']);
  });
  it.each(['corrupt-context', 'symlink-context', 'corrupt-latch', 'corrupt-refusals', 'corrupt-sidecar-receipt', 'oversized-refusals'])('isolates %s from capture migration and delivery', async (fault) => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'optional', 'capture before optional anomaly');
    const target = new MemberSpool(routeA, { mycoHome });
    if (fault === 'symlink-context') fs.symlinkSync(scratch, path.join(source.dir, 'context'));
    if (fault === 'corrupt-context') {
      fs.mkdirSync(path.join(source.dir, 'context'));
      fs.writeFileSync(path.join(source.dir, 'context', 'broken.json'), 'broken', { mode: 0o600 });
    }
    const sidecar = fault === 'corrupt-latch' ? 'offline.json' : fault === 'corrupt-refusals' ? 'refused.jsonl' : fault === 'corrupt-sidecar-receipt' ? '.legacy-sidecars.json' : null;
    if (sidecar !== null) fs.writeFileSync(path.join(source.dir, sidecar), 'broken', { mode: 0o600 });
    if (fault === 'oversized-refusals') {
      const entry = JSON.stringify({ eventId: 'oversized', reason: 'x'.repeat(REFUSED_LOG_MAX_BYTES) }) + '\n';
      fs.writeFileSync(path.join(source.dir, 'refused.jsonl'), entry, { mode: 0o600 });
      fs.writeFileSync(path.join(target.dir, 'refused.jsonl'), '{}\n', { mode: 0o600 });
    }
    const result = migrateLegacySpool(routeA, mycoHome);
    expect(result.status).toBe('migrated');
    expect(result.sidecarHolds!.length).toBeGreaterThan(0);
    expect(listLegacySpools(mycoHome)[0].sidecarHolds!.length).toBeGreaterThan(0);
    const client = new ServerClient({ ...routeA, token: rig.token }, rig.fetch);
    expect(await target.drainSession('optional', client, unboundedBudget(), { force: true })).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(fs.readFileSync(path.join(source.dir, 'optional.jsonl'), 'utf8')).toContain('capture before optional anomaly');
  });

  it('rebuilds an unreadable legacy cache while destination capture continues', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'unreadable-cache', 'capture beside unreadable cache');
    fs.mkdirSync(path.join(source.dir, 'context'));
    const cache = path.join(source.dir, 'context', 'project.json');
    fs.writeFileSync(cache, JSON.stringify({ version: 1, blocks: {} }), { mode: 0o600 });
    const read = fs.readFileSync.bind(fs);
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === cache) throw Object.assign(new Error('cache unavailable'), { code: 'EACCES' });
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      const migrated = migrateLegacySpool(routeA, mycoHome);
      expect(migrated).toMatchObject({ status: 'migrated', copied: 1 });
      expect(migrated.sidecarHolds).toContain('Legacy sidecar is unreadable: project.json');
      const target = new MemberSpool(routeA, { mycoHome });
      expect(await target.drainSession('unreadable-cache', new ServerClient({ ...routeA, token: rig.token }, rig.fetch), unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
      expect(await warmProjectContext({ ...routeA, token: rig.token }, { mycoHome, fetch: async () => Response.json({ persisted: true, context: 'rebuilt cache' }) })).toBeGreaterThan(0);
      expect(readProjectContext(target.dir).blocks.start?.context).toBe('rebuilt cache');
    } finally { guard.mockRestore(); }
    expect(fs.existsSync(cache)).toBe(true);
  });

  it('reports an active legacy helper while fresh destination capture delivers', async () => {
    const rig = await memberRig({ projectId });
    const entry = { ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt };
    writeRegistryEntry(entry, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'active-legacy', 'retained legacy capture');
    const target = new MemberSpool(routeA, { mycoHome });
    appendPrompt(target, 'fresh', 'fresh destination capture');
    const lease = LifecycleLock.acquire(path.join(source.dir, 'helper.lock'), { command: 'legacy helper fixture' });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;
    const notices: string[] = [];
    const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { notices.push(String(chunk)); return true; });
    try {
      const report = await drainEntryBacklog(entry, { mycoHome, fetch: rig.fetch });
      expect(report.sessions.some((session) => session.events?.acked === 1)).toBe(true);
      expect(notices.join('')).toContain('Legacy helper is still active');
      expect(rig.rows('prompt_batches')).toBe(1);
      expect(source.readRecords('active-legacy')).toHaveLength(1);
    } finally { stderr.mockRestore(); lease.lock.release(); }
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    expect(await target.drainSession('active-legacy', new ServerClient(entry, rig.fetch), unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('prompt_batches')).toBe(2);
  });

  it('reports temporary context artifacts without reading or copying them and drains healthy capture', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'temporary', 'healthy capture beside temp files');
    fs.mkdirSync(path.join(source.dir, 'context'));
    const file = path.join(source.dir, 'context', 'project.json.tmp');
    fs.writeFileSync(file, 'incomplete optional publication', { mode: 0o600 });
    const read = fs.readFileSync.bind(fs);
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(at) === file) throw new Error('temporary artifact must not be read');
      return read(at, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', ignoredSidecars: ['context/project.json.tmp'], sidecarHolds: [] });
      const target = new MemberSpool(routeA, { mycoHome });
      expect(fs.existsSync(path.join(target.dir, 'context', 'project.json.tmp'))).toBe(false);
      expect(await target.drainSession('temporary', new ServerClient({ ...routeA, token: rig.token }, rig.fetch), unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    } finally { guard.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe('incomplete optional publication');
  });

  it('validates 6000 retained records once and leaves markers byte-identical on stat-only retries', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    const event = promptEvent({ agent: 'claude-code', sessionId: 'large', stage: source.stagerFor('large') }, { promptId: mintId(), text: 'retained' });
    const rows = Array.from({ length: 6000 }, () => ({ ...event, envelope: { ...event.envelope, eventId: mintId() } }));
    source.appendAndRecord('large', rows);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 6000 });
    const target = new MemberSpool(routeA, { mycoHome });
    const marker = path.join(target.dir, LEGACY_MIGRATION_FILE);
    const original = fs.readFileSync(marker);
    const stat = fs.statSync(marker);
    const read = fs.readFileSync.bind(fs);
    const journalReads: string[] = [];
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith('large.jsonl')) { journalReads.push(String(file)); throw new Error('cached migration read retained journal'); }
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    const started = performance.now();
    try {
      for (let i = 0; i < 10; i++) expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
      expect(journalReads).toEqual([]);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally { guard.mockRestore(); }
    expect(fs.readFileSync(marker)).toEqual(original);
    expect(fs.statSync(marker).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.statSync(marker).ino).toBe(stat.ino);
    appendPrompt(source, 'large', 'old-version append');
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    expect(target.readRecords('large')).toHaveLength(6001);
  });

  it('keeps inline hooks within budget when a validated 6000-record source has a new old-version append', async () => {
    const rig = await memberRig({ projectId });
    const root = path.join(scratch, 'inline-repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    writeRegistryEntry({ ...binding(routeA.serverUrl, fs.realpathSync(root)), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    const event = promptEvent({ agent: 'claude-code', sessionId: 'retained', stage: source.stagerFor('retained') }, { promptId: mintId(), text: 'retained' });
    source.appendAndRecord('retained', Array.from({ length: 6000 }, () => ({ ...event, envelope: { ...event.envelope, eventId: mintId() } })));
    updateSessionState(source.dir, 'retained', (state) => { state.highWater = 6000; });
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    appendPrompt(source, 'retained', 'old writer after validation');
    const target = new MemberSpool(routeA, { mycoHome });
    const original = fs.readFileSync(path.join(target.dir, LEGACY_MIGRATION_FILE));
    const read = fs.readFileSync.bind(fs);
    const journalReads: string[] = [];
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === path.join(source.dir, 'retained.jsonl')) { journalReads.push(String(file)); throw new Error('inline hook must not scan retained migration source'); }
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      for (const hook of ['user-prompt-submit', 'session-end'] as const) {
        const started = performance.now();
        const result = await runHook(hook, { session_id: 'fresh', hook_event_name: hook === 'user-prompt-submit' ? 'UserPromptSubmit' : 'SessionEnd', cwd: root, prompt: 'fresh capture' }, { fetch: rig.fetch, symbiont: 'copilot', argv: ['--ship', 'inline'] });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(result.stderr).not.toContain('inline hook must not scan');
        expect(result.stderr).not.toContain('error:');
        expect(result.stderr).not.toContain('refused');
      }
      expect(journalReads).toEqual([]);
    } finally { guard.mockRestore(); }
    expect(fs.readFileSync(path.join(target.dir, LEGACY_MIGRATION_FILE))).toEqual(original);
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    expect(target.readRecords('retained')).toHaveLength(1);
  });

  it('holds an append between receipt verification and marker publication, then copies it once', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'validation-race', 'already copied');
    const file = path.join(source.dir, 'validation-race.jsonl');
    const late = promptEvent({ agent: 'claude-code', sessionId: 'validation-race', stage: source.stagerFor('validation-race') }, { promptId: mintId(), text: 'appended during final verification' });
    const read = fs.readFileSync.bind(fs);
    let reads = 0;
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, options?: unknown) => {
      const value = read(at, options as never);
      if (String(at) === file && ++reads === 2) fs.appendFileSync(file, JSON.stringify({ ...late.envelope, _memberProtocol: 1 }) + '\n');
      return value;
    }) as typeof fs.readFileSync);
    try { expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Legacy spool changed during validation' }); }
    finally { guard.mockRestore(); }
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    const target = new MemberSpool(routeA, { mycoHome });
    expect(target.readRecords('validation-race')).toHaveLength(2);
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 0 });
    expect(target.readRecords('validation-race')).toHaveLength(2);
  });

  it.each(['held', 'malformed'])('delivers healthy destination capture beside a %s legacy migration marker', async (state) => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const target = new MemberSpool(routeA, { mycoHome });
    appendPrompt(target, 'healthy-destination', 'healthy destination');
    fs.writeFileSync(path.join(target.dir, LEGACY_MIGRATION_FILE), state === 'malformed' ? 'broken' : JSON.stringify({ version: 1, state: 'held', reason: 'legacy capture anomaly' }), { mode: 0o600 });
    const client = new ServerClient({ ...routeA, token: rig.token }, rig.fetch);
    expect(await target.drainSession('healthy-destination', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it('retires a quiet legacy source even when routed capture changes throughout the grace window', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'quiet', 'quiet source');
    const target = new MemberSpool(routeA, { mycoHome });
    const now = Date.now();
    migrateLegacySpool(routeA, mycoHome, now);
    appendPrompt(target, 'active', 'routed capture during grace');
    migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS / 2);
    await target.drainSession('active', new ServerClient({ ...routeA, token: rig.token }, rig.fetch), unboundedBudget());
    appendPrompt(target, 'active', 'routed capture at retirement');
    expect(migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS).status).toBe('migrated');
    expect(listRetiredLegacySpoolDirs(mycoHome)).toHaveLength(1);
    expect(fs.readFileSync(path.join(listRetiredLegacySpoolDirs(mycoHome)[0], 'quiet.jsonl'), 'utf8')).toContain('quiet source');
  });

  it('waits a quiet grace window, moves retained bytes aside, and copies appends before and after retirement once', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    const start = Date.now();
    appendPrompt(source, 'retire', 'first');
    expect(migrateLegacySpool(routeA, mycoHome, start).copied).toBe(1);
    migrateLegacySpool(routeA, mycoHome, start + LEGACY_SPOOL_RETIRE_GRACE_MS - 1);
    expect(listRetiredLegacySpoolDirs(mycoHome)).toEqual([]);
    appendPrompt(source, 'retire', 'before retirement');
    expect(migrateLegacySpool(routeA, mycoHome, start + LEGACY_SPOOL_RETIRE_GRACE_MS).copied).toBe(1);
    expect(listRetiredLegacySpoolDirs(mycoHome)).toEqual([]);
    const open = fs.openSync(path.join(source.dir, 'retire.jsonl'), 'a');
    try {
      migrateLegacySpool(routeA, mycoHome, start + 2 * LEGACY_SPOOL_RETIRE_GRACE_MS);
      const archives = listRetiredLegacySpoolDirs(mycoHome);
      expect(archives).toHaveLength(1);
      expect(fs.readFileSync(path.join(archives[0], 'retire.jsonl'), 'utf8')).toContain('before retirement');
      expect(fs.existsSync(path.join(source.dir, 'retire.jsonl'))).toBe(false);
      const late = promptEvent({ agent: 'claude-code', sessionId: 'retire', stage: source.stagerFor('retire') }, { promptId: mintId(), text: 'open descriptor append '.repeat(25_000) });
      const record = { ...late.envelope, _memberProtocol: 1, _blobSource: late.blobSource };
      fs.writeSync(open, JSON.stringify(record) + '\n');
      appendPrompt(source, 'retire', 'after retirement');
      const copied = migrateLegacySpool(routeA, mycoHome, start + 2 * LEGACY_SPOOL_RETIRE_GRACE_MS + 1);
      expect(copied).toMatchObject({ status: 'migrated', copied: 2 });
      const target = new MemberSpool(routeA, { mycoHome });
      expect(target.readRecords('retire')).toHaveLength(4);
      expect(new Set(target.readRecords('retire').map((record) => record!.eventId)).size).toBe(4);
      const client = new ServerClient({ ...routeA, token: rig.token }, rig.fetch);
      expect(await target.drainSession('retire', client, unboundedBudget())).toMatchObject({ acked: 4, remaining: 0 });
      // Recreated legacy journals can repeat settled event IDs.
      fs.appendFileSync(path.join(source.dir, 'retire.jsonl'), JSON.stringify(record) + '\n');
      expect(migrateLegacySpool(routeA, mycoHome).copied).toBe(0);
      expect(await target.drainSession('retire', client, unboundedBudget())).toMatchObject({ acked: 0 });
      expect(rig.rows('prompt_batches')).toBe(4);
    } finally { fs.closeSync(open); }
  });

  it('recovers retired routing after an interrupted replacement and refuses a later Deployment binding', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'recover-retired', 'before retirement');
    const now = Date.now();
    migrateLegacySpool(routeA, mycoHome, now);
    migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS);
    expect(listRetiredLegacySpoolDirs(mycoHome)).toHaveLength(1);
    // An old writer recreates a journal before replacement routing is published.
    fs.unlinkSync(path.join(source.dir, 'destination.json'));
    writeRegistryEntry(binding(routeB.serverUrl), { mycoHome });
    appendPrompt(source, 'recover-retired', 'old writer retains original destination');
    expect(migrateLegacySpool(routeB, mycoHome).status).toBe('held');
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    expect(new MemberSpool(routeA, { mycoHome }).readRecords('recover-retired')).toHaveLength(2);
    expect(new MemberSpool(routeB, { mycoHome }).readRecords('recover-retired')).toHaveLength(0);
  });

  it('keeps unreadable payload bytes retryable through source retirement and delivers after the read recovers', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    const ctx = { agent: 'claude-code', sessionId: 'retired-blob', stage: source.stagerFor('retired-blob') };
    const event = promptEvent(ctx, { promptId: mintId(), text: 'retained payload '.repeat(25_000) });
    source.append('retired-blob', event);
    const file = event.blobSource!.path;
    const read = fs.readFileSync.bind(fs);
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(at) === file || String(at).includes(path.join('retired-spool', projectId)) && String(at).endsWith(event.blobSource!.sha256)) throw Object.assign(new Error('retained staging unreadable'), { code: 'EACCES' });
      return read(at, options as never);
    }) as typeof fs.readFileSync);
    const now = Date.now();
    const target = new MemberSpool(routeA, { mycoHome });
    const client = new ServerClient({ ...routeA, token: rig.token }, rig.fetch);
    try {
      expect(migrateLegacySpool(routeA, mycoHome, now).status).toBe('migrated');
      // Quiet source validation permits move-aside while the payload remains locally retryable.
      migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS);
      expect(listRetiredLegacySpoolDirs(mycoHome)).toHaveLength(1);
      await target.drainSession('retired-blob', client, unboundedBudget(), { now: () => now + LEGACY_SPOOL_RETIRE_GRACE_MS });
      await target.drainSession('retired-blob', client, unboundedBudget(), { now: () => now + LEGACY_SPOOL_RETIRE_GRACE_MS + 60_000 });
      expect(target.depth('retired-blob')).toBe(1);
      expect(new CaptureLossLedger(target.dir).read().payloads).toBe(0);
    } finally { guard.mockRestore(); }
    await target.drainSession('retired-blob', client, unboundedBudget(), { now: () => now + LEGACY_SPOOL_RETIRE_GRACE_MS + 3_600_000 });
    expect(target.depth('retired-blob')).toBe(0);
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(new CaptureLossLedger(target.dir).read().payloads).toBe(0);
  });

  it('defers retirement while an old hook owns the session append lock', () => {
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
    const source = legacy();
    appendPrompt(source, 'busy', 'retained while old hook owns append');
    const now = Date.now();
    migrateLegacySpool(routeA, mycoHome, now);
    const lease = LifecycleLock.acquire(bufferLockPath(source.dir, 'busy'), { command: 'old hook writing' });
    if (!lease.acquired) throw new Error('fixture append lease unavailable');
    try {
      expect(migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS).status).toBe('migrated');
      expect(listRetiredLegacySpoolDirs(mycoHome)).toEqual([]);
      expect(fs.readFileSync(path.join(source.dir, 'busy.jsonl'), 'utf8')).toContain('retained while old hook owns append');
    } finally { lease.lock.release(); }
    migrateLegacySpool(routeA, mycoHome, now + LEGACY_SPOOL_RETIRE_GRACE_MS + 1);
    expect(listRetiredLegacySpoolDirs(mycoHome)).toHaveLength(1);
  });

  it('holds migration while a destination drain is in flight and resumes without duplicating delivery', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    appendPrompt(source, 'concurrent', 'first');
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    const target = new MemberSpool(routeA, { mycoHome });
    appendPrompt(source, 'concurrent', 'second');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const onRequest = new Promise<void>((resolve) => { started = resolve; });
    const client = new ServerClient({ ...routeA, token: rig.token }, async (input, init) => { started(); await blocked; return rig.fetch(input, init); });
    const drain = target.drainSession('concurrent', client, unboundedBudget());
    await onRequest;
    try { expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'held', reason: 'Destination session is draining: concurrent' }); }
    finally { release(); }
    expect(await drain).toMatchObject({ acked: 1, remaining: 0 });
    expect(migrateLegacySpool(routeA, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
    expect(await target.drainSession('concurrent', new ServerClient({ ...routeA, token: rig.token }, rig.fetch), unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('prompt_batches')).toBe(2);
  });

  it('keeps an unreadable owned payload retryable when retained migration fallback paths are absent', async () => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    const event = promptEvent({ agent: 'claude-code', sessionId: 'owned-read', stage: source.stagerFor('owned-read') }, { promptId: mintId(), text: 'owned payload '.repeat(25_000) });
    source.append('owned-read', event);
    expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
    const target = new MemberSpool(routeA, { mycoHome });
    const file = path.join(target.dir, 'owned-read.jsonl');
    const row = target.readRecords('owned-read')[0]!;
    row._blobSource!.migrationSource = { path: path.join(source.blobsDirFor('owned-read'), 'absent'), retiredPath: path.join(mycoHome, 'member', 'retired-spool', projectId, 'absent') };
    fs.writeFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    const read = fs.readFileSync.bind(fs);
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(at) === row._blobSource!.path) throw Object.assign(new Error('owned payload temporarily unreadable'), { code: 'EACCES' });
      return read(at, options as never);
    }) as typeof fs.readFileSync);
    const client = new ServerClient({ ...routeA, token: rig.token }, rig.fetch);
    const now = Date.now();
    try {
      await target.drainSession('owned-read', client, unboundedBudget(), { now: () => now });
      await target.drainSession('owned-read', client, unboundedBudget(), { now: () => now + 60_000 });
      expect(target.depth('owned-read')).toBe(1);
      expect(new CaptureLossLedger(target.dir).read().payloads).toBe(0);
      expect(rig.rows('prompt_batches')).toBe(0);
    } finally { guard.mockRestore(); }
    expect(await target.drainSession('owned-read', client, unboundedBudget(), { now: () => now + 3_600_000 })).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it.each(['missing', 'EACCES', 'EIO', 'corrupt'])('migrates %s payload metadata into owned staging while the healthy tail delivers', async (failure) => {
    const rig = await memberRig({ projectId });
    writeRegistryEntry({ ...binding(routeA.serverUrl), token: rig.token, expiresAt: rig.expiresAt }, { mycoHome });
    const source = legacy();
    const ctx = { agent: 'claude-code', sessionId: 'payload', stage: source.stagerFor('payload') };
    const large = promptEvent(ctx, { promptId: mintId(), text: 'large payload '.repeat(25_000) });
    source.appendAndRecord('payload', [sessionStartEvent(ctx, {}), large, promptEvent(ctx, { promptId: mintId(), text: 'healthy tail' })]);
    const file = large.blobSource!.path;
    const original = fs.readFileSync(file);
    if (failure === 'missing') fs.unlinkSync(file);
    if (failure === 'corrupt') fs.truncateSync(file, 1);
    const read = fs.readFileSync.bind(fs);
    const guard = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(at) === file && (failure === 'EACCES' || failure === 'EIO')) throw Object.assign(new Error('transient migration read'), { code: failure });
      return read(at, options as never);
    }) as typeof fs.readFileSync);
    const now = Date.now();
    const target = new MemberSpool(routeA, { mycoHome });
    const answers: string[] = [];
    const client = new ServerClient({ ...routeA, token: rig.token }, async (input, init) => {
      const result = await rig.fetch(input, init);
      if (new URL(String(input)).pathname === '/events') answers.push((await result.clone().json() as { code?: string }).code ?? 'acked');
      return result;
    });
    try {
      expect(migrateLegacySpool(routeA, mycoHome).status).toBe('migrated');
      expect(target.readRecords('payload')[1]!._blobSource!.path.startsWith(target.blobsDirFor('payload'))).toBe(true);
      await target.drainSession('payload', client, unboundedBudget(), { now: () => now });
      expect(rig.rows('prompt_batches')).toBe(1);
      expect(target.depth('payload')).toBe(1);
      await target.drainSession('payload', client, unboundedBudget(), { now: () => now + 60_000 });
      if (failure === 'EACCES' || failure === 'EIO') {
        expect(target.depth('payload')).toBe(1);
        expect(new CaptureLossLedger(target.dir).read().payloads).toBe(0);
      } else {
        expect(target.depth('payload')).toBe(0);
        expect(answers).toContain('blob_absent');
        expect(new CaptureLossLedger(target.dir).read().payloads).toBe(1);
      }
    } finally { guard.mockRestore(); }
    if (failure === 'EACCES' || failure === 'EIO') {
      expect(fs.readFileSync(file)).toEqual(original);
      await target.drainSession('payload', client, unboundedBudget(), { now: () => now + 3_600_000 });
      expect(target.depth('payload')).toBe(0);
      expect(rig.rows('prompt_batches')).toBe(2);
    }
  });

});
