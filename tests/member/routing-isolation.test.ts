import { locateTranscript } from '@myco/member/legacy-import.js';
import { prunePluginTranscripts } from '@myco/member/retention.js';
import { rootKeyFor } from '@myco/member/auto-join.js';
import { pendingSpool, appendPending, flushPending } from '@myco/member/pending.js';
import { transcriptPointerFor, shipSessionTranscripts } from '@myco/member/transcript.js';
import { memberTranscriptRoutingKey, assertMemberTranscriptDestination } from '@myco/member/transcript-routing.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemberSpool } from '@myco/member/spool.js';
import { helperPass } from '@myco/member/helper-pass.js';
import { helperPaths, runHelper } from '@myco/member/helper.js';
import { kickWaitingProjects } from '@myco/member/sweep.js';
import { routingEntry, sameRoutingIdentity } from '@myco/member/routing.js';
import { deploymentPath, readDeploymentMembership, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { rotatedCredential } from '@myco/member/refresh.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { promptEvent, mintId } from '@myco/member/envelope.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { cacheDeploymentFeatures, readDeploymentFeaturesStrict, readProjectContext, updateProjectContext } from '@myco/member/context-cache.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { shipSession, type Candidate } from '@myco/member/import.js';
import { resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { probeWorkerAdmission } from '@myco/runner/loop.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember, runHook } from './helpers/hooks.js';

const PROJECT = 'proj_same';
const SESSION = 'sess_same';
const A = 'https://a.routing.invalid';
const B = 'https://b.routing.invalid';
let mycoHome: string;
let priorHome: string | undefined;
beforeEach(() => { priorHome = process.env.MYCO_HOME; mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => { if (priorHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = priorHome; });

async function pair(now: number = Date.now()) {
  const a = await memberRig({ projectId: PROJECT, now });
  const b = await memberRig({ projectId: PROJECT, now });
  const roots = [path.join(mycoHome, 'repo-a'), path.join(mycoHome, 'repo-b')];
  for (const root of roots) { fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]); }
  const entries = [
    registerTestMember({ mycoHome, root: roots[0], serverUrl: A, token: a.token, projectId: PROJECT, expiresAt: a.expiresAt }),
    registerTestMember({ mycoHome, root: roots[1], serverUrl: B, token: b.token, projectId: PROJECT, expiresAt: b.expiresAt }),
  ];
  const calls: Array<{ url: string; destination: string }> = [];
  let offline = false;
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    const destination = req.url.startsWith(A) ? A : req.url.startsWith(B) ? B : '';
    expect(destination).not.toBe('');
    const membership = readDeploymentMembership(destination, mycoHome)!;
    // Credential comparison stays inside the assertion and never enters the capture log.
    expect(req.headers.get('authorization') === `Bearer ${membership.token}`).toBe(true);
    if (new URL(req.url).pathname !== '/tokens/refresh' && !new URL(req.url).pathname.startsWith('/worker/')) expect(req.headers.get('x-myco-project')).toBe(PROJECT);
    calls.push({ url: req.url, destination });
    if (offline) throw new Error('offline scratch Deployment');
    return (destination === A ? a : b).fetch(input, init);
  };
  return { a, b, entries, calls, fetch, setOffline: (value: boolean) => { offline = value; } };
}

describe('Deployment and Project member routing', () => {
  it('isolates real hooks, offline backlog, helper restart, caches and session cursors with identical IDs', async () => {
    const rig = await pair();
    for (const entry of rig.entries) {
      const started = performance.now();
      const hook = await runHook('user-prompt-submit', { session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: entry.root, prompt: entry.serverUrl }, { fetch: rig.fetch, symbiont: 'copilot' });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(hook.stderr).not.toContain('error:');
      expect(hook.starts.some((args) => args.includes(entry.serverUrl))).toBe(true);
    }
    expect(rig.calls).toHaveLength(0);
    const spools = rig.entries.map((entry) => new MemberSpool(entry, { mycoHome }));
    expect(spools[0].dir).not.toBe(spools[1].dir);
    expect(helperPaths(PROJECT, mycoHome, A).lock).not.toBe(helperPaths(PROJECT, mycoHome, B).lock);
    updateProjectContext(spools[0].dir, mycoHome, (cache) => { cache.features = ['turn']; cache.featuresAt = 1; cache.blocks.start = { context: 'A context', at: 1 }; });
    updateProjectContext(spools[1].dir, mycoHome, (cache) => { cache.features = []; cache.featuresAt = 2; cache.blocks.start = { context: 'B context', at: 2 }; });
    expect(readDeploymentFeaturesStrict(rig.entries[0], mycoHome)).toEqual(['turn']);
    expect(readDeploymentFeaturesStrict(rig.entries[1], mycoHome)).toEqual([]);
    cacheDeploymentFeatures(A, ['turn'], mycoHome);
    cacheDeploymentFeatures(B, [], mycoHome);
    expect(readProjectContext(spools[0].dir).blocks.start?.context).toBe('A context');
    expect(readProjectContext(spools[1].dir).blocks.start?.context).toBe('B context');
    updateSessionState(spools[0].dir, SESSION, (state) => { state.promptId = 'prompt_a'; });
    updateSessionState(spools[1].dir, SESSION, (state) => { state.promptId = 'prompt_b'; });
    expect(readSessionState(spools[0].dir, SESSION).promptId).toBe('prompt_a');
    expect(readSessionState(spools[1].dir, SESSION).promptId).toBe('prompt_b');
    rig.setOffline(true);
    await helperPass(rig.entries[0], mycoHome, { fetch: rig.fetch })(Date.now() + 5000, { force: true });
    expect(spools[0].readLatch()).not.toBeNull();
    expect(spools[1].readLatch()).toBeNull();
    rig.setOffline(false);
    for (const entry of rig.entries) await runHelper({ projectId: PROJECT, serverUrl: entry.serverUrl, mycoHome, lingerMs: 0, pass: helperPass(entry, mycoHome, { fetch: rig.fetch }) });
    await helperPass(rig.entries[0], mycoHome, { fetch: rig.fetch })(Date.now() + 5000, { force: true });
    expect(rig.a.rows('events')).toBe(1);
    expect(rig.b.rows('events')).toBe(1);
    expect(spools.map((spool) => spool.depth(SESSION))).toEqual([0, 0]);
    expect(new Set(rig.calls.map((call) => call.destination))).toEqual(new Set([A, B]));
  });

  it('pins plugin transcript storage and refuses bytes from a different destination', async () => {
    const rig = await pair();
    const keys = rig.entries.map((entry) => memberTranscriptRoutingKey('registry', entry.root, mycoHome, process.env));
    expect(keys[0]).not.toBe(keys[1]);
    const files = keys.map((key, index) => {
      const file = path.join(mycoHome, 'member', 'transcripts', key, 'opencode', `${SESSION}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: rig.entries[index].root, message: { role: 'user', content: rig.entries[index].serverUrl } }) + '\n');
      return file;
    });
    expect(() => assertMemberTranscriptDestination(files[0], rig.entries[1], mycoHome)).toThrow('does not match');
    expect(() => assertMemberTranscriptDestination(files[0], rig.entries[0], path.join(mycoHome, 'foreign-home'))).toThrow('another member home');
    expect(() => assertMemberTranscriptDestination(path.join(rig.entries[0].root, 'member', 'transcripts', 'ordinary.jsonl'), rig.entries[0], mycoHome)).not.toThrow();
    expect(locateTranscript('opencode', SESSION, null, { route: rig.entries[0], mycoHome })?.file).toBe(files[0]);
    expect(locateTranscript('opencode', SESSION, null, { route: rig.entries[1], mycoHome })?.file).toBe(files[1]);
    expect(locateTranscript('opencode', SESSION, null)).toBeNull();
    const spool = new MemberSpool(rig.entries[1], { mycoHome });
    const candidate: Candidate = { agent: 'opencode', sessionId: SESSION, transcriptId: 'unused', filePath: files[0], root: rig.entries[0].root, sizeBytes: fs.statSync(files[0]).size, modifiedAt: Date.now(), headHash: 'unused' };
    await expect(shipSession(candidate, 0, new ServerClient(rig.entries[1], rig.fetch), spool, 'machine_1', Date.now)).rejects.toThrow('does not match');
    expect(rig.calls).toHaveLength(0);
    writeRegistryEntry({ ...rig.entries[1], root: rig.entries[0].root }, { mycoHome });
    expect(memberTranscriptRoutingKey('registry', rig.entries[0].root, mycoHome, process.env)).toBe(keys[1]);
    expect(() => assertMemberTranscriptDestination(files[0], rig.entries[0], mycoHome)).not.toThrow();
    expect(fs.readFileSync(files[0], 'utf8')).toContain(A);
    const unknownRoot = path.join(mycoHome, 'unbound');
    fs.mkdirSync(unknownRoot); execFileSync('git', ['init', '-q', unknownRoot]);
    expect(() => memberTranscriptRoutingKey('registry', unknownRoot, mycoHome, process.env)).toThrow('default Deployment');
    recordDefaultDeployment(A, { mycoHome });
    const pendingA = memberTranscriptRoutingKey('registry', unknownRoot, mycoHome, process.env);
    recordDefaultDeployment(B, { mycoHome, replace: true });
    expect(memberTranscriptRoutingKey('registry', unknownRoot, mycoHome, process.env)).not.toBe(pendingA);
  });

  it('adopts pending transcript bytes once and drains both primary files across joining', async () => {
    const rig = await pair();
    const root = path.join(mycoHome, 'joining');
    fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
    recordDefaultDeployment(A, { mycoHome });
    const key = memberTranscriptRoutingKey('registry', root, mycoHome, process.env);
    const pendingFile = path.join(mycoHome, 'member', 'transcripts', key, 'opencode', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify({ type: 'user', message: { role: 'user', content: 'before joining' } }) + '\n');
    const repo = { root, rootKey: rootKeyFor(root, mycoHome), serverUrl: A };
    expect(() => assertMemberTranscriptDestination(pendingFile, rig.entries[0], mycoHome)).toThrow('adoption');
    expect(() => assertMemberTranscriptDestination(pendingFile, { serverUrl: A, projectId: '' }, mycoHome, 'different-root')).toThrow('does not match');
    const held = pendingSpool(repo, { mycoHome, now: Date.now() })!;
    appendPending(repo, SESSION, [], (state) => { state.transcript = transcriptPointerFor(pendingFile, 'machine_1')!; }, { mycoHome, now: Date.now() });
    expect(held.stateSessionIds()).toContain(SESSION);
    writeRegistryEntry({ ...rig.entries[0], root }, { mycoHome });
    const spool = new MemberSpool(rig.entries[0], { mycoHome });
    flushPending(repo.rootKey, spool, { mycoHome, now: Date.now() });
    const nextKey = memberTranscriptRoutingKey('registry', root, mycoHome, process.env);
    const nextFile = path.join(mycoHome, 'member', 'transcripts', nextKey, 'opencode', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(nextFile), { recursive: true });
    fs.writeFileSync(nextFile, JSON.stringify({ type: 'user', message: { role: 'user', content: 'after joining' } }) + '\n');
    updateSessionState(spool.dir, SESSION, (state) => { state.transcript = transcriptPointerFor(nextFile, 'machine_1')!; });
    expect(readSessionState(spool.dir, SESSION).continuations?.[pendingFile].nextOffset).toBe(0);
    const ctx = { agent: 'opencode', sessionId: SESSION, stage: spool.stagerFor(SESSION) };
    const result = await shipSessionTranscripts(ctx, spool, new ServerClient(rig.entries[0], rig.fetch), unboundedBudget(), { machineId: 'machine_1' });
    expect(result).toEqual({ shipped: 2, endedBy: 'done' });
    const state = readSessionState(spool.dir, SESSION);
    expect(state.continuations?.[pendingFile].nextOffset).toBe(fs.statSync(pendingFile).size);
    expect(state.transcript?.nextOffset).toBe(fs.statSync(nextFile).size);
    expect((await shipSessionTranscripts(ctx, spool, new ServerClient(rig.entries[0], rig.fetch), unboundedBudget(), { machineId: 'machine_1' })).shipped).toBe(0);
    expect(() => assertMemberTranscriptDestination(pendingFile, { serverUrl: A, projectId: 'different-project' }, mycoHome)).toThrow('adoption');
    expect(rig.b.rows('events')).toBe(0);
  });

  it('holds an unavailable explicit binding instead of routing capture to the default', async () => {
    const rig = await pair();
    recordDefaultDeployment(B, { mycoHome });
    fs.unlinkSync(deploymentPath(A, mycoHome));
    expect(() => memberTranscriptRoutingKey('registry', rig.entries[0].root, mycoHome, process.env)).toThrow('Explicit Project binding');
    const hook = await runHook('user-prompt-submit', { session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: rig.entries[0].root, prompt: 'held for A' }, { symbiont: 'copilot', fetch: rig.fetch });
    expect(hook.stderr).toContain('binding');
    expect(hook.stderr).toContain('unavailable');
    expect(rig.calls).toHaveLength(0);
    expect(hook.starts).toHaveLength(0);
    expect(fs.existsSync(path.join(mycoHome, 'member', 'pending'))).toBe(false);
  });

  it('holds legacy raw transcripts when one Deployment has multiple Project routes', async () => {
    const rig = await pair();
    writeRegistryEntry({ ...rig.entries[0], root: rig.entries[1].root, projectId: 'other-project' }, { mycoHome });
    fs.unlinkSync(deploymentPath(B, mycoHome));
    const file = path.join(mycoHome, 'member', 'transcripts', 'opencode', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); fs.utimesSync(file, old, old);
    expect(() => assertMemberTranscriptDestination(file, rig.entries[0], mycoHome)).toThrow('ambiguous');
    expect(prunePluginTranscripts(Date.now(), process.env, mycoHome)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses uniqueness proof from an unreadable second Deployment membership', async () => {
    const rig = await pair();
    writeRegistryEntry({ ...rig.entries[0], root: rig.entries[1].root }, { mycoHome });
    fs.writeFileSync(deploymentPath(B, mycoHome), '{}', { mode: 0o600 });
    const file = path.join(mycoHome, 'member', 'transcripts', 'opencode', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
    expect(() => assertMemberTranscriptDestination(file, rig.entries[0], mycoHome)).toThrow('ambiguous');
    expect(fs.existsSync(`${file}.destination.json`)).toBe(false);
  });

  it('refuses mismatched delivery and refresh clients before any outbound request', async () => {
    const rig = await pair();
    const spool = new MemberSpool(rig.entries[0], { mycoHome });
    spool.append(SESSION, promptEvent({ sessionId: SESSION, agent: 'claude-code', stage: spool.stagerFor(SESSION) }, { promptId: mintId(), text: 'capture for A' }));
    await expect(spool.drainSession(SESSION, new ServerClient(rig.entries[1], rig.fetch), unboundedBudget())).rejects.toThrow('buffered destination');
    expect(rig.calls).toHaveLength(0);
    const expected = rig.entries[0];
    writeRegistryEntry({ ...rig.entries[1], root: expected.root }, { mycoHome });
    expect(rotatedCredential(expected.root, expected, mycoHome)).toBeNull();
    const membership = readDeploymentMembership(A, mycoHome)!;
    writeDeploymentMembership({ ...membership, token: 'synthetic-rotated-a' }, { mycoHome });
    const rotated = rotatedCredential(expected.root, expected, mycoHome)!;
    expect(sameRoutingIdentity(rotated, expected)).toBe(true);
    expect(rotated.token === 'synthetic-rotated-a').toBe(true);
  });

  it('refreshes each original destination before replay after a rebind', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const rig = await pair(Date.now() - 6.5 * DAY_MS);
    const predecessorTokens = rig.entries.map((entry) => entry.token);
    for (const entry of rig.entries) {
      const spool = new MemberSpool(entry, { mycoHome });
      spool.append(SESSION, promptEvent({ sessionId: SESSION, agent: 'copilot', stage: spool.stagerFor(SESSION) }, { promptId: mintId(), text: entry.serverUrl }));
    }
    writeRegistryEntry({ ...rig.entries[1], root: rig.entries[0].root }, { mycoHome });
    for (const entry of rig.entries) await helperPass(entry, mycoHome, { fetch: rig.fetch })(Date.now() + 5000, { force: true });
    expect(rig.entries.map((entry, index) => readDeploymentMembership(entry.serverUrl, mycoHome)!.token !== predecessorTokens[index])).toEqual([true, true]);
    expect(rig.calls.filter((call) => call.url.endsWith('/tokens/refresh')).map((call) => call.destination)).toEqual([A, B]);
    expect([rig.a.rows('events'), rig.b.rows('events')]).toEqual([1, 1]);
  });

  it('keeps old buffered capture deliverable after its last repository rebinds', async () => {
    const rig = await pair();
    const old = rig.entries[0];
    const spool = new MemberSpool(old, { mycoHome });
    spool.append(SESSION, promptEvent({ sessionId: SESSION, agent: 'claude-code', stage: spool.stagerFor(SESSION) }, { promptId: mintId(), text: 'old A capture' }));
    writeRegistryEntry({ ...rig.entries[1], root: old.root }, { mycoHome });
    expect(routingEntry(old, mycoHome)?.serverUrl).toBe(A);
    const started: string[][] = [];
    kickWaitingProjects(mycoHome, rig.entries[1], { spawn: (_command, args) => { started.push([...args]); return { started: true }; } });
    expect(started.some((args) => args.includes(A))).toBe(true);
    await helperPass(old, mycoHome, { fetch: rig.fetch })(Date.now() + 5000, { force: true });
    expect(rig.a.rows('events')).toBe(1);
    expect(rig.b.rows('events')).toBe(0);
    expect(rig.calls.every((call) => call.destination === A)).toBe(true);
  });

  it('isolates transcript import receipts and routes MCP and worker clients to their selected memberships', async () => {
    const rig = await pair();
    const file = path.join(mycoHome, 'transcript.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'scratch transcript' } }) + '\n');
    const candidate: Candidate = { agent: 'claude-code', sessionId: SESSION, transcriptId: 'unused', filePath: file, root: rig.entries[0].root, sizeBytes: fs.statSync(file).size, modifiedAt: Date.now(), headHash: 'unused' };
    for (const entry of rig.entries) {
      const spool = new MemberSpool(entry, { mycoHome });
      expect(await shipSession(candidate, 0, new ServerClient(entry, rig.fetch), spool, 'machine_1', Date.now, { facts: false })).toBe('done');
      expect(readSessionState(spool.dir, SESSION).transcript?.nextOffset).toBe(fs.statSync(file).size);
      const upstream = resolveDeploymentUpstream('registry', { cwd: entry.root, mycoHome, invokedBy: 'mcp' })!;
      expect(upstream.mcpUrl.origin).toBe(entry.serverUrl);
      expect(upstream.headers.authorization === `Bearer ${readDeploymentMembership(entry.serverUrl, mycoHome)!.token}`).toBe(true);
      await rig.fetch(upstream.mcpUrl, { method: 'POST', headers: { ...upstream.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      await probeWorkerAdmission({ serverUrl: entry.serverUrl, token: () => readDeploymentMembership(entry.serverUrl, mycoHome)!.token, renew: async () => 'not-due', signal: AbortSignal.timeout(3000), fetchImpl: rig.fetch as typeof fetch });
    }
    expect(new Set(rig.calls.filter((call) => call.url.endsWith('/mcp')).map((call) => call.destination))).toEqual(new Set([A, B]));
    expect(new Set(rig.calls.filter((call) => call.url.endsWith('/worker/lease')).map((call) => call.destination))).toEqual(new Set([A, B]));
  });
});
