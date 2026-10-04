import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { removeRegistryEntry, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { assignLegacySpoolDestination, migrateLegacySpool, pinLegacySpoolDestination, pinLegacySpoolDestinationForProject, legacySpoolDir, LEGACY_MIGRATION_FILE, listLegacySpools } from '@myco/member/spool-migration.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { behindTranscriptPaths, pruneDeliveredSessionState, prunePluginTranscripts } from '@myco/member/retention.js';
import { ServerClient } from '@myco/member/transport.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
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
    const pending = appendPrompt(source, 'session-two', 'x'.repeat(300_000));
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
    writeRegistryEntry(binding(routeA.serverUrl), { mycoHome });
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
});
