import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireRegistryLock, removeRegistryEntry, deploymentKeyFor, listRegistryEntriesResult, projectsDir, readRegistryEntry, readRegistryEntryResult,
  registryEntryPath, registryKeyFor, REGISTRY_VERSION, writeDeploymentMembership, writeRegistryEntry, type RegistryEntry,
} from '@myco/member/registry.js';
import { canonicalRootIdentity } from '@myco/utils/git-files.js';
import { resolveMemberProjectRoot, resolveCredential } from '@myco/member/credential.js';
import { rootKeyFor, machineSalt, listJoinRequests, markLeft, isLeft, clearLeft, joinStanding, writeAutoJoinState, autoJoinDir, markSweepDone, requestJoin, queueImport, listPendingImports, autoJoinIdentityIssues } from '@myco/member/auto-join.js';
import { autoJoinHold, LEFT_ALONE } from '@myco/member/auto-join-hook.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { appendPending, listPending, pendingSpool, pendingDir, withPendingLock } from '@myco/member/pending.js';
import { runStatus, runMcpHeaders, runLeave } from '@myco/cli/member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { joinPass, optOut, runAutoJoin, settleConnection } from '@myco/cli/member-auto-join.js';
import { runHook } from './helpers/hooks.js';
import { ensureMemberDir } from '@myco/member/store.js';
import { attributeTranscript } from '@myco/symbionts/transcript-attribution.js';
import { promptEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState } from '@myco/member/session-state.js';
import { flushHeldCapture, restoreHeldReceiptsForHook } from '@myco/member/held.js';
import { cacheMachineSettings } from '@myco/member/machine-settings.js';
import { memberRig, TEST_MACHINE_ID, TEST_PROJECT_ID } from './helpers/server.js';
import { resetMachineIdCache } from '@myco/machine-id.js';


function supportsCaseAliases(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-probe-'));
  try {
    const name = path.join(probe, 'Case');
    fs.mkdirSync(name);
    const alternate = path.join(probe, 'cASE');
    return fs.existsSync(alternate) && fs.statSync(name).ino === fs.statSync(alternate).ino;
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
const caseAliases = supportsCaseAliases();
function windowsShortPath(at: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-short-path-'));
  const script = path.join(directory, 'short-path.ps1');
  try {
    fs.writeFileSync(script, 'param([string]$Path)\n$ErrorActionPreference = "Stop"\n(New-Object -ComObject Scripting.FileSystemObject).GetFolder($Path).ShortPath\n');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, at], { encoding: 'utf8' }).trim();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function supportsShortNames(): boolean {
  if (process.platform !== 'win32') return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-short-name-'));
  try {
    const long = fs.realpathSync.native(probe);
    const short = windowsShortPath(long);
    if (!fs.existsSync(short)) throw new Error('Short-path helper returned a nonexistent directory: ' + short);
    return short !== long && /~[0-9]/.test(short);
  }
  finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
const shortNames = supportsShortNames();
function supportsFileLinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-file-link-'));
  try {
    fs.writeFileSync(path.join(probe, 'file'), 'fixture');
    try { fs.symlinkSync(path.join(probe, 'file'), path.join(probe, 'link'), 'file'); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
      throw error;
    }
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
const fileLinks = supportsFileLinks();


let base: string;
let mycoHome: string;
let root: string;
let alias: string;
const savedHome = process.env.MYCO_HOME;
const savedTemporary = process.env.MYCO_TEMPORARY_FOLDERS;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-identity-'));
  root = path.join(base, 'Physical', 'Repo');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const link = path.join(base, 'alias');
  fs.symlinkSync(path.dirname(root), link, 'junction');
  alias = path.join(link, 'Repo');
  mycoHome = path.join(base, 'home');
  process.env.MYCO_HOME = mycoHome;
  process.env.MYCO_TEMPORARY_FOLDERS = path.join(base, 'excluded');
});
afterEach(() => {
  resetMachineIdCache();
  fs.rmSync(base, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  if (savedTemporary === undefined) delete process.env.MYCO_TEMPORARY_FOLDERS; else process.env.MYCO_TEMPORARY_FOLDERS = savedTemporary;
});

const entry = (at: string, serverUrl = 'https://personal.invalid', projectId = 'proj_personal'): RegistryEntry => ({
  version: REGISTRY_VERSION, root: at, projectId, serverUrl, token: 'fake', machineId: 'machine', joinedAt: 1, updatedAt: 1,
});
const oldPath = (at: string) => path.join(projectsDir(mycoHome), crypto.createHash('sha256').update(path.resolve(at)).digest('hex').slice(0, 16) + '.json');
function oldBinding(at: string, serverUrl = 'https://personal.invalid', projectId = 'proj_personal'): string {
  writeDeploymentMembership({ serverUrl, token: 'fake', machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  ensureMemberDir(projectsDir(mycoHome), mycoHome);
  const { token: _token, machineId: _machineId, ...binding } = entry(at, serverUrl, projectId);
  fs.writeFileSync(oldPath(at), JSON.stringify(binding), { mode: 0o600 });
  return oldPath(at);
}
function defaultWork(): void {
  writeDeploymentMembership({ serverUrl: 'https://work.invalid', token: 'F'.repeat(43), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  recordDefaultDeployment('https://work.invalid', { mycoHome });
}

const legacyRootKey = (at: string): string => crypto.createHash('sha256').update(machineSalt(mycoHome) + '\0' + fs.realpathSync(at)).digest('hex').slice(0, 32);

function heldAlias(serverUrl = 'https://personal.invalid', at = alias) {
  const repo = { root: at, rootKey: legacyRootKey(at), serverUrl };
  const opts = { mycoHome, now: Date.now() };
  const spool = pendingSpool(repo, opts)!;
  const event = promptEvent({ agent: 'claude-code', sessionId: 'held-alias', stage: spool.stagerFor('held-alias'), now: () => opts.now },
    { promptId: 'prompt-old-key', text: 'retained capture' });
  appendPending(repo, 'held-alias', [event], state => { state.prompts.receipt = 'prompt-old-key'; }, opts);
  return { repo, opts, event };
}

it.skipIf(!caseAliases)('restores held receipts from an old key through every repository spelling (host volume must be case-insensitive)', () => {
  const held = heldAlias();
  const live = new MemberSpool(entry(root), { mycoHome });
  withPendingLock(held.repo.rootKey, mycoHome, () => restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts));
  expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBe('prompt-old-key');
});

it.skipIf(!caseAliases)('settling a canonical connection replays old-key held capture only from its own Deployment, idempotently (host volume must be case-insensitive)', async () => {
  const held = heldAlias();
  heldAlias('https://work.invalid');
  const workFile = path.join(pendingDir(held.repo.rootKey, mycoHome, 'https://work.invalid'), 'held-alias.jsonl');
  const workBytes = fs.readFileSync(workFile);
  writeRegistryEntry(entry(root), { mycoHome });
  const connected = readRegistryEntry(root, mycoHome)!;
  expect(await settleConnection(connected, { mycoHome, now: () => held.opts.now, tell: false })).toBe(1);
  const live = new MemberSpool(connected, { mycoHome });
  expect(live.readRecords('held-alias').map(record => record?.eventId)).toEqual([held.event.envelope.eventId]);
  expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBe('prompt-old-key');
  expect(await settleConnection(connected, { mycoHome, now: () => held.opts.now, tell: false })).toBe(0);
  expect(fs.readFileSync(workFile)).toEqual(workBytes);
});

it.skipIf(!caseAliases)('old-key opt-outs keep the strongest restriction across aliases until an explicit local connection (host volume must be case-insensitive)', () => {
  defaultWork();
  const oldKey = legacyRootKey(alias);
  markLeft(oldKey, mycoHome, 1, { explicitJoinOnly: true, repository: { root: alias } });
  const key = rootKeyFor(root, mycoHome);
  expect(isLeft(key, mycoHome)).toBe(true);
  markLeft(key, mycoHome, 2, { repository: { root } });
  fs.unlinkSync(path.join(mycoHome, 'member/auto-join/left', `${oldKey}.json`));
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.auto_join_roots': [base], 'capture.connect_roots': { [key]: 'proj_choice' } } }, mycoHome);
  let later = 0;
  expect(autoJoinHold({ root, hookName: 'session-start', agent: 'claude-code', sessionId: 'old-left', mycoHome, now: 3, env: { MYCO_TEMPORARY_FOLDERS: path.join(base, 'excluded') }, later: () => { later++; } })).toBe(LEFT_ALONE);
  expect(later).toBe(0);
  expect(listPending({ mycoHome, now: 3 })).toEqual([]);
  clearLeft(key, mycoHome);
  expect(isLeft(key, mycoHome)).toBe(false);
});

it('an unattributed old opt-out stays local to its key and is preserved by another root clear', () => {
  defaultWork();
  markLeft('e'.repeat(32), mycoHome, 1, { explicitJoinOnly: true });
  const key = rootKeyFor(root, mycoHome);
  clearLeft(key, mycoHome);
  expect(isLeft(key, mycoHome)).toBe(false);
  expect(isLeft('e'.repeat(32), mycoHome)).toBe(true);
  expect(autoJoinIdentityIssues(mycoHome).map(issue => issue.kind)).toEqual(['opt-out']);
});

it('native-expanded roots find opt-outs and choices recorded under a generic short spelling', () => {
  const generic = fs.realpathSync.bind(fs);
  const native = fs.realpathSync.native;
  const legacy = spyOn(fs, 'realpathSync').mockImplementation(((...args: Parameters<typeof fs.realpathSync>) =>
    String(args[0]) === alias ? alias : Reflect.apply(generic, fs, args)) as typeof fs.realpathSync);
  Object.assign(fs.realpathSync, { native });
  try {
    const oldKey = legacyRootKey(alias);
    const key = rootKeyFor(root, mycoHome);
    expect(key).not.toBe(oldKey);
    markLeft(oldKey, mycoHome, 1, { explicitJoinOnly: true, repository: { root: alias } });
    writeAutoJoinState({ root: alias, rootKey: oldKey, label: 'Repo', serverUrl: 'https://work.invalid', outcome: 'unreachable', attemptAt: 1 }, mycoHome);
    expect(isLeft(key, mycoHome)).toBe(true);
    cacheMachineSettings('https://work.invalid', { leaves: { 'capture.connect_roots': { [oldKey]: 'proj_choice' } } }, mycoHome);
    const standing = joinStanding(root, key, 'https://work.invalid', mycoHome, 2);
    expect(standing.state?.rootKey).toBe(oldKey);
    expect(standing.leaves.connectRoots[key]).toBe('proj_choice');
    clearLeft(key, mycoHome);
    expect(fs.existsSync(path.join(mycoHome, 'member/auto-join/left', `${oldKey}.json`))).toBe(false);
  } finally { legacy.mockRestore(); }
});

it.skipIf(!caseAliases)('saved dashboard connection choices and backoff follow old keys through canonical aliases (host volume must be case-insensitive)', () => {
  const oldKey = legacyRootKey(alias);
  writeAutoJoinState({ root: alias, rootKey: oldKey, label: 'Repo', serverUrl: 'https://work.invalid', outcome: 'unreachable', attemptAt: 1 }, mycoHome);
  const key = rootKeyFor(root, mycoHome);
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.auto_join_roots': [base], 'capture.connect_roots': { [oldKey]: 'proj_choice' } } }, mycoHome);
  const standing = joinStanding(root, key, 'https://work.invalid', mycoHome, 2);
  expect(standing.leaves.connectRoots[key]).toBe('proj_choice');
  expect(standing.state?.rootKey).toBe(oldKey);
});

it.skipIf(!caseAliases)('a saved old-key dashboard choice reaches that Project through the real resolver (host volume must be case-insensitive)', async () => {
  const rig = await memberRig();
  const serverUrl = 'https://work.invalid';
  writeDeploymentMembership({ serverUrl, token: rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
  recordDefaultDeployment(serverUrl, { mycoHome });
  fs.writeFileSync(path.join(mycoHome, 'machine_id'), TEST_MACHINE_ID, { mode: 0o600 });
  resetMachineIdCache();
  rig.env.sqlite.run('INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)', [TEST_MACHINE_ID, `mem_${TEST_MACHINE_ID}`, Date.now()]);
  const oldKey = legacyRootKey(alias);
  writeAutoJoinState({ root: alias, rootKey: oldKey, label: 'Repo', serverUrl, outcome: 'outside_folders', attemptAt: 1 }, mycoHome);
  rig.env.sqlite.run("INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.connect_roots', ?, 1, ?)",
    [TEST_MACHINE_ID, JSON.stringify({ [oldKey]: TEST_PROJECT_ID }), `mem_${TEST_MACHINE_ID}`]);
  const result = await runAutoJoin(['--root', root], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
  expect(result[0]?.result).toBe('joined');
  expect(readRegistryEntry(root, mycoHome)?.projectId).toBe(TEST_PROJECT_ID);
});

it('an unknown saved choice is reported without blocking a known choice for another folder', () => {
  const key = rootKeyFor(root, mycoHome);
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.auto_join_roots': [base], 'capture.connect_roots': { [key]: 'proj_known', ['e'.repeat(32)]: 'proj_unknown' } } }, mycoHome);
  expect(joinStanding(root, key, 'https://work.invalid', mycoHome, 2).leaves.connectRoots[key]).toBe('proj_known');
});

it('missing metadata with held bytes is surfaced by receipt recovery and automatic replay', () => {
  const held = heldAlias();
  const dir = pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl);
  const bytes = fs.readFileSync(path.join(dir, 'held-alias.jsonl'));
  fs.unlinkSync(path.join(dir, 'pending.json'));
  const live = new MemberSpool(entry(root), { mycoHome });
  expect(() => restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts)).toThrow('metadata missing');
  expect(() => flushHeldCapture(root, entry(root), held.opts)).toThrow('metadata missing');
  expect(fs.readFileSync(path.join(dir, 'held-alias.jsonl'))).toEqual(bytes);
});

it('expired capture budgets leave held keys intact without enumerating them', () => {
  const held = heldAlias();
  const scan = spyOn(fs, 'readdirSync');
  try {
    expect(flushHeldCapture(root, entry(root), { ...held.opts, deadline: 0 })).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); }
  expect(fs.existsSync(path.join(pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl), 'held-alias.jsonl'))).toBe(true);
});

it('a retargeted recorded alias cannot transfer capture, opt-outs, or a saved choice to another repository', () => {
  const held = heldAlias();
  markLeft(held.repo.rootKey, mycoHome, 1, { explicitJoinOnly: true, repository: { root: alias } });
  const otherParent = path.join(base, 'Other');
  const other = path.join(otherParent, 'Repo');
  fs.mkdirSync(other, { recursive: true });
  fs.unlinkSync(path.join(base, 'alias'));
  fs.symlinkSync(otherParent, path.join(base, 'alias'), 'junction');
  const key = rootKeyFor(other, mycoHome);
  const live = new MemberSpool(entry(other), { mycoHome });
  expect(() => flushHeldCapture(other, entry(other), held.opts)).toThrow('identity unavailable');
  restoreHeldReceiptsForHook(other, 'held-alias', live, held.opts);
  expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBeUndefined();
  clearLeft(key, mycoHome);
  expect(fs.existsSync(path.join(mycoHome, 'member/auto-join/left', `${held.repo.rootKey}.json`))).toBe(true);
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.auto_join_roots': [base], 'capture.connect_roots': { [held.repo.rootKey]: 'proj_original' } } }, mycoHome);
  expect(() => joinStanding(other, key, 'https://work.invalid', mycoHome, 2)).toThrow('unavailable identity');
  expect(isLeft(rootKeyFor(root, mycoHome), mycoHome)).toBe(true);
});

it('queued legacy joins and imports retain stale aliases without executing their new target', async () => {
  defaultWork();
  markSweepDone(mycoHome, 1);
  const key = legacyRootKey(alias);
  const serverUrl = 'https://work.invalid';
  const request = path.join(autoJoinDir(mycoHome), 'requests', deploymentKeyFor(serverUrl), `${key}.json`);
  const pendingImport = path.join(autoJoinDir(mycoHome), 'imports', deploymentKeyFor(serverUrl), 'proj_work', `${key}.json`);
  for (const [file, value] of [[request, { root: alias, rootKey: key, serverUrl, at: 1 }], [pendingImport, { root: alias, rootKey: key, serverUrl, projectId: 'proj_work', at: 1 }]] as const) {
    ensureMemberDir(path.dirname(file), mycoHome);
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }
  const bytes = [request, pendingImport].map(file => fs.readFileSync(file));
  const otherParent = path.join(base, 'Other');
  const other = path.join(otherParent, 'Repo');
  fs.mkdirSync(other, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: other });
  fs.unlinkSync(path.join(base, 'alias'));
  fs.symlinkSync(otherParent, path.join(base, 'alias'), 'junction');
  const calls: string[] = [];
  await joinPass(mycoHome, { fetch: (async input => { calls.push(String(input)); throw new Error('unexpected connection'); }) as import('@myco/member/transport.js').FetchLike })(Date.now() + 10_000, { force: false });
  expect(calls).toEqual([]);
  expect(listJoinRequests(mycoHome)).toEqual([]);
  expect(listPendingImports(mycoHome)).toEqual([]);
  expect(readRegistryEntry(other, mycoHome)).toBeNull();
  expect([request, pendingImport].map(file => fs.readFileSync(file))).toEqual(bytes);
});

it('new join and import queues pin the physical repository before a display alias retargets', () => {
  const serverUrl = 'https://work.invalid';
  const key = rootKeyFor(alias, mycoHome);
  requestJoin(alias, key, serverUrl, mycoHome, 1);
  queueImport({ root: alias, rootKey: key, serverUrl, projectId: 'proj_work', at: 1 }, mycoHome);
  const otherParent = path.join(base, 'Other');
  fs.mkdirSync(path.join(otherParent, 'Repo'), { recursive: true });
  fs.unlinkSync(path.join(base, 'alias'));
  fs.symlinkSync(otherParent, path.join(base, 'alias'), 'junction');
  expect(listJoinRequests(mycoHome).map(row => canonicalRootIdentity(row.root))).toEqual([canonicalRootIdentity(root)]);
  expect(listPendingImports(mycoHome).map(row => canonicalRootIdentity(row.root))).toEqual([canonicalRootIdentity(root)]);
});

it.skipIf(!caseAliases)('leave discards old-key held capture across Deployments and preserves another repository (host volume must be case-insensitive)', async () => {
  const held = heldAlias();
  heldAlias('https://work.invalid');
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  const kept = heldAlias('https://personal.invalid', other);
  const keptFile = path.join(pendingDir(kept.repo.rootKey, mycoHome, kept.repo.serverUrl), 'held-alias.jsonl');
  const keptBytes = fs.readFileSync(keptFile);
  await optOut(root, null, { mycoHome, now: held.opts.now });
  expect(fs.existsSync(pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl))).toBe(false);
  expect(fs.existsSync(pendingDir(held.repo.rootKey, mycoHome, 'https://work.invalid'))).toBe(false);
  expect(fs.readFileSync(keptFile)).toEqual(keptBytes);
  writeRegistryEntry(entry(root), { mycoHome });
  expect(await settleConnection(readRegistryEntry(root, mycoHome)!, { mycoHome, now: () => held.opts.now, tell: false })).toBe(0);
});

async function aliasGate(spellings: string[]): Promise<void> {
  defaultWork();
  for (const bound of spellings) {
    writeRegistryEntry(entry(bound), { mycoHome });
    expect(JSON.parse(fs.readFileSync(registryEntryPath(bound, mycoHome), 'utf8')).root).toBe(canonicalRootIdentity(root));
    for (const cwd of spellings) {
      expect(registryKeyFor(cwd)).toBe(registryKeyFor(bound));
      expect(rootKeyFor(cwd, mycoHome)).toBe(rootKeyFor(bound, mycoHome));
      expect(canonicalRootIdentity(resolveMemberProjectRoot(cwd))).toBe(canonicalRootIdentity(root));
      expect(readRegistryEntry(cwd, mycoHome)?.serverUrl).toBe('https://personal.invalid');
      expect(resolveCredential('registry', { cwd, mycoHome, env: {} })?.serverUrl).toBe('https://personal.invalid');
      let later = 0;
      expect(autoJoinHold({ root: cwd, hookName: 'session-start', agent: 'claude-code', sessionId: 'alias', mycoHome, now: 1, env: {}, later: () => { later += 1; } })).toBeNull();
      expect(later).toBe(0);
      const requests: string[] = [];
      await runHook('session-start', { session_id: 'alias', cwd }, {
        fetch: (async (url: string | URL | Request) => { requests.push(String(url)); return new Response('{}', { status: 503 }); }) as import('@myco/member/transport.js').FetchLike,
      });
      expect(requests.some(url => url.startsWith('https://work.invalid'))).toBe(false);
      expect(listJoinRequests(mycoHome)).toEqual([]);
      expect(listPending({ mycoHome, now: 1 })).toEqual([]);
    }
  }
}
it('alias gate: every symlinked ancestor spelling finds its binding and cannot hold for the default Myco', async () => {
  await aliasGate([root, alias]);
});
it.skipIf(process.platform !== 'darwin')('alias gate: /tmp and /private/tmp (host must provide the macOS alias)', async () => {
  const physical = fs.realpathSync.native(root);
  const short = physical.replace(/^\/private\/tmp\//, '/tmp/');
  expect(short).not.toBe(physical);
  await aliasGate([physical, short, alias]);
});
it.skipIf(!caseAliases)('alias gate: case variants (host volume must be case-insensitive)', async () => {
  const variant = path.join(path.dirname(root), 'rEPO');
  await aliasGate([root, variant, alias]);
});
it('migration finds an old-keyed alias from another spelling and rekeys it while holding the registry lock', () => {
  const old = oldBinding(alias);
  const lock = acquireRegistryLock(mycoHome);
  expect(lock.acquired).toBe(true);
  if (!lock.acquired) throw new Error('fixture lock unavailable');
  try {
    expect(readRegistryEntry(root, mycoHome)?.serverUrl).toBe('https://personal.invalid');
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.existsSync(registryEntryPath(root, mycoHome))).toBe(false);
  } finally { lock.lock.release(); }
  const rename = fs.renameSync;
  const lockedWrite = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === registryEntryPath(root, mycoHome)) {
      const concurrent = acquireRegistryLock(mycoHome);
      if (concurrent.acquired) concurrent.lock.release();
      expect(concurrent.acquired).toBe(false);
    }
    return rename(from, to);
  }) as typeof fs.renameSync);
  try { expect(readRegistryEntry(root, mycoHome)?.serverUrl).toBe('https://personal.invalid'); }
  finally { lockedWrite.mockRestore(); }
  expect(JSON.parse(fs.readFileSync(old, 'utf8'))).toMatchObject({ version: 0, kind: 'canonical-root' });
  const stored = JSON.parse(fs.readFileSync(registryEntryPath(root, mycoHome), 'utf8'));
  expect(stored.root).toBe(canonicalRootIdentity(root));
  expect(stored.displayRoot).toBe(alias);
});
it('a crash after the canonical write leaves both readable; the next read replaces the duplicate with a stub', () => {
  const old = oldBinding(alias);
  const rename = fs.renameSync;
  const crash = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === old) throw new Error('simulated crash after write');
    return rename(from, to);
  }) as typeof fs.renameSync);
  try { expect(() => readRegistryEntry(root, mycoHome)).toThrow('simulated crash'); }
  finally { crash.mockRestore(); }
  expect(fs.existsSync(old)).toBe(true);
  expect(fs.existsSync(registryEntryPath(root, mycoHome))).toBe(true);
  expect(readRegistryEntryResult(alias, mycoHome).status).toBe('present');
  expect(readRegistryEntry(root, mycoHome)?.serverUrl).toBe('https://personal.invalid');
  expect(JSON.parse(fs.readFileSync(old, 'utf8'))).toMatchObject({ version: 0, kind: 'canonical-root' });
});
for (const disagreement of ['Deployment', 'Project']) {
  it('disagreeing ' + disagreement + ' alias bindings stay intact, appear in doctor/status, and cannot capture or auto-join', async () => {
    const one = oldBinding(alias);
    const two = oldBinding(root, disagreement === 'Deployment' ? 'https://other.invalid' : 'https://personal.invalid', 'proj_other');
    defaultWork();
    const bytes = [one, two].map(at => fs.readFileSync(at, 'utf8'));
    expect(readRegistryEntryResult(root, mycoHome, { upgrade: true }).status).toBe('unavailable');
    expect(listRegistryEntriesResult(mycoHome).conflicts).toHaveLength(1);
    expect(listRegistryEntriesResult(mycoHome).entries).toEqual([]);
    expect(() => writeRegistryEntry(entry(root), { mycoHome })).toThrow('Repository connection conflict');
    const lines: string[] = [];
    runStatus([], { cwd: root, mycoHome, stdout: line => lines.push(line), stderr: line => lines.push(line) });
    const checks = await homeReport(mycoHome, { cwd: root, fetch: (async () => new Response('{}', { status: 503 })) as import('@myco/member/transport.js').FetchLike });
    for (const text of [lines.join('\n'), checks.map(c => c.detail).join('\n')]) {
      expect(text).toContain('Repository connection conflict');
      expect(text).toContain(alias);
      expect(text).toContain(root);
      expect(text).toContain('automatic connection are stopped');
    }
    const headerOutput: string[] = [];
    const headerErrors: string[] = [];
    const exit = process.exitCode;
    try {
      runMcpHeaders(['--credential', 'registry', '--server', 'https://work.invalid'], {
        cwd: root, mycoHome, stdout: line => headerOutput.push(line), stderr: line => headerErrors.push(line),
      });
      expect(headerOutput).toEqual([]);
      expect(headerErrors.join('\n')).toContain('Repository connection conflict');
    } finally { process.exitCode = exit ?? 0; }
    let calls = 0;
    expect(await runAutoJoin(['--root', root], { cwd: root, mycoHome, env: {}, fetch: (async () => { calls++; return new Response('{}'); }) as import('@myco/member/transport.js').FetchLike, stdout: () => {}, stderr: () => {} })).toEqual([{ root, result: 'binding-unavailable' }]);
    await runHook('session-start', { session_id: 'conflict', cwd: alias }, {
      fetch: (async () => { calls++; return new Response('{}'); }) as import('@myco/member/transport.js').FetchLike,
    });
    expect(calls).toBe(0);
    expect(listJoinRequests(mycoHome)).toEqual([]);
    expect(listPending({ mycoHome, now: 1 })).toEqual([]);
    expect([one, two].map(at => fs.readFileSync(at, 'utf8'))).toEqual(bytes);
  });
}

it.skipIf(!shortNames)('alias gate: live Windows 8.3 names (host volume must provide short names)', async () => {
  const long = fs.realpathSync.native(root);
  const short = windowsShortPath(long);
  expect(fs.existsSync(short)).toBe(true);
  expect(short).not.toBe(long);
  await aliasGate([long, short, alias]);
});
it.skipIf(process.platform !== 'win32' || !/~[0-9]/.test(os.tmpdir()))('alias gate: live Windows short ancestor (host temp directory must have a short ancestor)', async () => {
  const long = fs.realpathSync.native(root);
  expect(path.dirname(root)).not.toBe(path.dirname(long));
  expect(fs.existsSync(root)).toBe(true);
  await aliasGate([root, long, alias]);
});
for (const legacy of [false, true]) it('a main checkout bound through injected native 8.3 expansion is found from linked long-name Git pointers (legacy: ' + legacy + ')', () => {
  const linked = path.join(base, 'linked');
  const gitDir = path.join(root, '.git', 'worktrees', 'linked');
  fs.mkdirSync(linked);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ' + fs.realpathSync.native(gitDir) + '\n');
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'gitdir'), path.join(linked, '.git') + '\n');
  const short = path.join(base, 'RUNNER~1', 'Repo');
  const native = fs.realpathSync.native;
  const expansion = spyOn(fs.realpathSync, 'native').mockImplementation(((at: fs.PathLike) =>
    native(String(at) === short ? root : at)) as typeof fs.realpathSync.native);
  try {
    if (legacy) oldBinding(short); else writeRegistryEntry(entry(short), { mycoHome });
    expect(canonicalRootIdentity(resolveMemberProjectRoot(linked))).toBe(canonicalRootIdentity(root));
    expect(resolveCredential('registry', { cwd: linked, mycoHome, env: {} })?.serverUrl).toBe('https://personal.invalid');
    expect(rootKeyFor(short, mycoHome)).toBe(rootKeyFor(root, mycoHome));
  } finally { expansion.mockRestore(); }
});
for (const damage of ['malformed', 'loose-mode', 'outside-link']) {
  it.skipIf(process.platform === 'win32' && damage === 'loose-mode' || !fileLinks && damage === 'outside-link')('a ' + damage + ' old alias entry fails closed for its identifiable root and preserves another binding (mode and file-link variants require host support)', () => {
    const old = oldBinding(alias);
    oldBinding(root, 'https://work.invalid', 'proj_work');
    defaultWork();
    if (damage === 'malformed') fs.writeFileSync(old, '{');
    if (damage === 'loose-mode') fs.chmodSync(old, 0o644);
    if (damage === 'outside-link') {
      const outside = path.join(base, 'outside.json');
      fs.renameSync(old, outside);
      fs.symlinkSync(outside, old);
    }
    for (const at of damage === 'loose-mode' ? [root, alias] : [alias]) {
      expect(readRegistryEntryResult(at, mycoHome, { upgrade: true }).status).toBe('unavailable');
      expect(autoJoinHold({ root: at, hookName: 'session-start', agent: 'claude-code', sessionId: 'damaged', mycoHome, now: 1, env: {}, later: () => { throw new Error('must not join'); } })).toBeNull();
    }
    if (damage === 'loose-mode') expect(() => writeRegistryEntry(entry(root), { mycoHome })).toThrow('could not be read');
    else expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
    expect(fs.existsSync(old)).toBe(true);
    expect(listPending({ mycoHome, now: 1 })).toEqual([]);
  });
}
it('held capture and status share canonical root identity across aliases', () => {
  const key = rootKeyFor(root, mycoHome);
  const opts = { mycoHome, now: 1 };
  const personal = 'https://personal.invalid';
  const held = pendingSpool({ root, rootKey: key, serverUrl: personal }, opts)!;
  held.append('held-alias', { envelope: {
    eventId: '00000000-0000-7000-8000-000000000001', sessionId: 'held-alias', kind: 'session.end', createdAt: 1,
    channel: 'cli', producer: { adapter: 'test', version: '1' }, payload: {},
  } });
  expect(pendingSpool({ root: alias, rootKey: key, serverUrl: personal }, opts)?.dir).toBe(held.dir);
  const lines: string[] = [];
  runStatus([], { cwd: alias, mycoHome, now: () => 1, stdout: line => lines.push(line), stderr: () => {} });
  expect(lines.join('\n')).toContain('1 event(s) in 1 session(s)');
});
it('cached binding reads observe in-place edits and POSIX permissions where supported before deciding a repository is unconnected', () => {
  writeRegistryEntry(entry(root), { mycoHome });
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
  const file = registryEntryPath(root, mycoHome);
  fs.writeFileSync(file, '{');
  expect(readRegistryEntryResult(alias, mycoHome).status).toBe('unavailable');
  writeRegistryEntry(entry(root), { mycoHome });
  expect(readRegistryEntryResult(alias, mycoHome).status).toBe('present');
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    expect(readRegistryEntryResult(alias, mycoHome).status).toBe('unavailable');
  }
});
it('a writer migrates a v1 alias binding before updating its Project', () => {
  ensureMemberDir(projectsDir(mycoHome), mycoHome);
  fs.writeFileSync(oldPath(alias), JSON.stringify({ ...entry(alias), version: 1 }), { mode: 0o600 });
  writeRegistryEntry(entry(root, 'https://personal.invalid', 'proj_updated'), { mycoHome });
  expect(JSON.parse(fs.readFileSync(oldPath(alias), 'utf8'))).toMatchObject({ version: 0, kind: 'canonical-root' });
  expect(readRegistryEntry(alias, mycoHome)?.projectId).toBe('proj_updated');
});

it('a retargeted display symlink cannot redirect listed repository work to another Project', () => {
  writeRegistryEntry(entry(alias), { mycoHome });
  const other = path.join(base, 'Other');
  fs.mkdirSync(path.join(other, 'Repo'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path.join(other, 'Repo') });
  fs.unlinkSync(path.dirname(alias));
  fs.symlinkSync(other, path.dirname(alias), 'junction');
  const selected = readRegistryEntry(root, mycoHome);
  expect(selected?.root).toBe(canonicalRootIdentity(root));
  expect(selected?.displayRoot).toBe(alias);
  expect(listRegistryEntriesResult(mycoHome).entries.map(e => e.root)).toEqual([canonicalRootIdentity(root)]);
  expect(readRegistryEntryResult(alias, mycoHome).status).toBe('missing');
});

it.skipIf(!caseAliases)('transcript placement uses case-probed identity when native realpath preserves the recorded case', () => {
  const variant = path.join(path.dirname(root), 'rEPO');
  const transcript = path.join(base, 'case-transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: variant }) + '\n');
  const native = fs.realpathSync.native;
  const preservesCase = spyOn(fs.realpathSync, 'native').mockImplementation(((at: fs.PathLike) => {
    const resolved = native(at);
    return String(at) === variant ? path.join(path.dirname(resolved), path.basename(variant)) : resolved;
  }) as typeof fs.realpathSync.native);
  try {
    expect(attributeTranscript('claude-code', transcript, [root], { git: { mainCheckout: cwd => cwd } })).toEqual({ kind: 'bound', root });
  } finally { preservesCase.mockRestore(); }
});

it('moving a bound ancestor behind a symlink stays local and can be rejoined in fresh processes', () => {
  const other = path.join(base, 'Other', 'RepoB');
  fs.mkdirSync(other, { recursive: true });
  writeRegistryEntry(entry(root), { mycoHome });
  writeRegistryEntry(entry(other, 'https://work.invalid', 'proj_work'), { mycoHome });
  const moved = path.join(base, 'Disk', 'Physical');
  fs.mkdirSync(path.dirname(moved));
  fs.renameSync(path.dirname(root), moved);
  fs.symlinkSync(moved, path.dirname(root), 'junction');
  const module = path.resolve('packages/myco/src/member/registry.ts');
  const readFresh = (at: string): string => execFileSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e',
    `import { readRegistryEntryResult } from ${JSON.stringify(module)}; const r=readRegistryEntryResult(${JSON.stringify(at)},${JSON.stringify(mycoHome)}); console.log(r.status === 'present' ? r.entry.projectId : r.status);`],
  { cwd: base, encoding: 'utf8' }).trim();
  expect(readFresh(other)).toBe('proj_work');
  expect(readFresh(root)).toBe('proj_personal');
  writeRegistryEntry(entry(root, 'https://personal.invalid', 'proj_rejoined'), { mycoHome });
  expect(readFresh(root)).toBe('proj_rejoined');
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unsearchable bound folder fails closed only for itself (host requires POSIX permissions)', () => {
  const other = path.join(base, 'Other', 'RepoB');
  fs.mkdirSync(other, { recursive: true });
  writeRegistryEntry(entry(root), { mycoHome });
  writeRegistryEntry(entry(other, 'https://work.invalid', 'proj_work'), { mycoHome });
  execFileSync('/bin/chmod', ['000', path.dirname(root)]);
  try {
    expect(readRegistryEntryResult(other, mycoHome).status).toBe('present');
    expect(readRegistryEntryResult(path.join(base, 'Unbound'), mycoHome).status).toBe('missing');
    expect(readRegistryEntryResult(root, mycoHome).status).toBe('unavailable');
  } finally { execFileSync('/bin/chmod', ['700', path.dirname(root)]); }
});

it('an orphaned opt-out and choice never suppress holding for an unrelated repository', () => {
  defaultWork();
  const key = legacyRootKey(alias);
  markLeft(key, mycoHome, 1, { repository: { root: alias } });
  writeAutoJoinState({ root: alias, rootKey: key, label: 'Repo', outcome: 'outside_folders', serverUrl: 'https://work.invalid', attemptAt: 1 }, mycoHome);
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.connect_roots': { [key]: 'proj_old' } } }, mycoHome);
  fs.unlinkSync(path.join(base, 'alias'));
  const unrelated = path.join(base, 'Unrelated');
  fs.mkdirSync(unrelated);
  execFileSync('git', ['init', '-q'], { cwd: unrelated });
  const held = autoJoinHold({ root: unrelated, hookName: 'session-end', agent: 'claude-code', sessionId: 'unrelated', mycoHome, now: 2, env: { MYCO_TEMPORARY_FOLDERS: path.join(base, 'excluded') }, later: () => {} });
  expect(held).not.toBe(LEFT_ALONE);
  expect(held).not.toBeNull();
  expect(typeof held === 'object' && held?.spool).toBeTruthy();
});

it('a canonical binding lookup does not parse other migrated bindings', () => {
  for (let index = 0; index < 20; index++) {
    const at = path.join(base, 'Other' + index);
    fs.mkdirSync(at);
    writeRegistryEntry(entry(at), { mycoHome });
  }
  writeRegistryEntry(entry(root), { mycoHome });
  const read = spyOn(fs, 'readFileSync');
  try {
    expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
    const bindings = read.mock.calls.filter(([at]) => String(at).startsWith(projectsDir(mycoHome)) && String(at).endsWith('.json'));
    expect(bindings.length).toBeLessThanOrEqual(1);
  } finally { read.mockRestore(); }
});

it('a cached binding follows an ancestor move instead of reporting a missing repository', () => {
  writeRegistryEntry(entry(root), { mycoHome });
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
  const moved = path.join(base, 'Moved');
  fs.renameSync(path.dirname(root), moved);
  fs.symlinkSync(moved, path.dirname(root), 'junction');
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
});

function freshRootIdentityProbe(repository: string, operation: 'lookup' | 'autoJoinHold') {
  const source = 'import {readRegistryEntryResult} from ' + JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))
    + '; import {autoJoinHold} from ' + JSON.stringify(path.resolve('packages/myco/src/member/auto-join-hook.ts'))
    + '; const root=' + JSON.stringify(repository) + ',mycoHome=' + JSON.stringify(mycoHome)
    + '; let queued=0; const result=' + (operation === 'lookup' ? 'readRegistryEntryResult(root,mycoHome)' : 'autoJoinHold({root,mycoHome,hookName:"session-end",agent:"claude-code",sessionId:"moved",now:2,env:{MYCO_TEMPORARY_FOLDERS:' + JSON.stringify(path.join(base, 'excluded')) + '},later:()=>queued++})')
    + '; console.log(JSON.stringify({result,queued}));';
  return JSON.parse(execFileSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e', source], { cwd: base, encoding: 'utf8' }));
}

for (const depth of [2, 3]) for (const operation of ['lookup', 'autoJoinHold'] as const) {
  it('a fresh ' + operation + ' rejects a stale proof after an ancestor moves at depth ' + depth, () => {
    const ancestor = path.join(base, 'Move');
    const repository = path.join(ancestor, ...Array.from({ length: depth - 1 }, (_, index) => 'Group' + index), 'repo');
    fs.mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repository });
    defaultWork();
    writeRegistryEntry(entry(repository), { mycoHome });
    expect(fs.existsSync(path.join(mycoHome, 'member', 'registry-canonical'))).toBe(true);
    const moved = path.join(base, 'Disk', 'Move');
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(ancestor, moved);
    fs.symlinkSync(moved, ancestor, 'junction');
    const answer = freshRootIdentityProbe(repository, operation);
    if (operation === 'lookup') {
      expect(['present', 'unavailable']).toContain(answer.result.status);
      if (answer.result.status === 'present') expect(answer.result.entry.serverUrl).toBe('https://personal.invalid');
    } else expect(answer.result).toBeNull();
    expect(answer.queued).toBe(0);
    expect(listJoinRequests(mycoHome)).toEqual([]);
    expect(listPending({ mycoHome, now: 2 })).toEqual([]);
  });
}

for (const operation of ['lookup', 'autoJoinHold'] as const) it('a fresh ' + operation + ' rejects a stale proof after deletion and a same-name symlink replacement', () => {
  const replacement = path.join(base, 'Replacement');
  fs.mkdirSync(replacement);
  execFileSync('git', ['init', '-q'], { cwd: replacement });
  defaultWork();
  writeRegistryEntry(entry(root), { mycoHome });
  expect(fs.existsSync(path.join(mycoHome, 'member', 'registry-canonical'))).toBe(true);
  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(replacement, root, 'junction');
  const answer = freshRootIdentityProbe(root, operation);
  if (operation === 'lookup') {
    expect(['present', 'unavailable']).toContain(answer.result.status);
    if (answer.result.status === 'present') expect(answer.result.entry.serverUrl).toBe('https://personal.invalid');
  } else expect(answer.result).toBeNull();
  expect(answer.queued).toBe(0);
  expect(listJoinRequests(mycoHome)).toEqual([]);
  expect(listPending({ mycoHome, now: 2 })).toEqual([]);
});

it('an in-place legacy binding rewrite invalidates the proof before an expanded-identity lookup', () => {
  const expanded = path.join(base, 'expanded-name');
  fs.mkdirSync(expanded);
  const literal = canonicalRootIdentity(root);
  writeRegistryEntry(entry(root), { mycoHome });
  const file = registryEntryPath(root, mycoHome);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...value, version: 2, root: literal }));
  const native = fs.realpathSync.native;
  fs.realpathSync.native = ((at: fs.PathLike) => native(String(at) === literal ? expanded : at)) as typeof native;
  try { expect(readRegistryEntryResult(expanded, mycoHome)).toMatchObject({ status: 'present', entry: { serverUrl: 'https://personal.invalid' } }); }
  finally { fs.realpathSync.native = native; }
});

it('explicit connection replacement and leave resolve only the selected repository conflict', () => {
  oldBinding(root);
  oldBinding(alias, 'https://work.invalid', 'proj_work');
  const unrelated = path.join(base, 'Unrelated');
  fs.mkdirSync(unrelated);
  writeRegistryEntry(entry(unrelated, 'https://unrelated.invalid', 'proj_unrelated'), { mycoHome });
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('unavailable');
  writeRegistryEntry(entry(root), { mycoHome, resolveConflict: true });
  expect(readRegistryEntry(root, mycoHome)?.projectId).toBe('proj_personal');
  expect(readRegistryEntry(unrelated, mycoHome)?.projectId).toBe('proj_unrelated');
  oldBinding(alias, 'https://work.invalid', 'proj_work');
  expect(runLeave([], { cwd: root, mycoHome, stdout: () => {}, stderr: () => {} })).toBe(true);
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('missing');
  expect(readRegistryEntry(unrelated, mycoHome)?.projectId).toBe('proj_unrelated');
});

it('receipt recovery reads candidate keys without enumerating other held directories', () => {
  const held = heldAlias();
  const live = new MemberSpool(entry(root), { mycoHome });
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  pendingSpool({ root: other, rootKey: rootKeyFor(other, mycoHome), serverUrl: held.repo.serverUrl }, held.opts);
  restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts);
  const scan = spyOn(fs, 'readdirSync');
  try {
    restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts);
    expect(scan.mock.calls.some(([at]) => String(at) === path.dirname(pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl)))).toBe(false);
    expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBe('prompt-old-key');
  } finally { scan.mockRestore(); }
});

it('an orphaned connection for this alias stays local and cannot throw through the hook', async () => {
  defaultWork();
  const key = legacyRootKey(alias);
  markLeft(key, mycoHome, 1, { repository: { root: alias } });
  writeAutoJoinState({ root: alias, rootKey: key, label: 'Repo', outcome: 'outside_folders', serverUrl: 'https://work.invalid', attemptAt: 1 }, mycoHome);
  const other = path.join(base, 'Other', 'Repo');
  fs.mkdirSync(other, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: other });
  fs.unlinkSync(path.join(base, 'alias'));
  fs.symlinkSync(path.dirname(other), path.join(base, 'alias'), 'junction');
  cacheMachineSettings('https://work.invalid', { leaves: { 'capture.connect_roots': { [key]: 'proj_old' } } }, mycoHome);
  expect(autoJoinHold({ root: alias, hookName: 'session-end', agent: 'claude-code', sessionId: 'local-choice', mycoHome, now: 2,
    env: { MYCO_TEMPORARY_FOLDERS: path.join(base, 'excluded') }, later: () => { throw new Error('must not join'); } })).toBe(LEFT_ALONE);
  const lines: string[] = [];
  runStatus([], { cwd: other, mycoHome, stdout: line => lines.push(line), stderr: line => lines.push(line) });
  const checks = await homeReport(mycoHome, { cwd: other, fetch: (async () => new Response('{}', { status: 503 })) as import('@myco/member/transport.js').FetchLike });
  for (const text of [lines.join('\n'), checks.map(check => check.detail).join('\n')]) {
    expect(text.match(/Saved Myco connection/g)).toHaveLength(1);
    expect(text.match(/Saved opt-out/g)).toHaveLength(1);
    expect(text).toContain('myco member join');
  }
});

it('the cold canonical fast path never canonicalizes other migrated bindings', () => {
  for (let index = 0; index < 20; index++) {
    const at = path.join(base, 'Other' + index);
    fs.mkdirSync(at);
    writeRegistryEntry(entry(at), { mycoHome });
  }
  writeRegistryEntry(entry(root), { mycoHome });
  const source = 'import fs from "node:fs"; import {readRegistryEntryResult} from '
    + JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))
    + '; const native=fs.realpathSync.native; let other=0; fs.realpathSync.native=(p)=>{if(String(p).toLowerCase().startsWith('
    + JSON.stringify(path.join(base, 'Other').toLowerCase()) + ')) other++; return native(p)}; const r=readRegistryEntryResult('
    + JSON.stringify(root) + ',' + JSON.stringify(mycoHome) + '); console.log(JSON.stringify({status:r.status,other}));';
  const result = JSON.parse(execFileSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e', source], { cwd: base, encoding: 'utf8' }));
  expect(result).toEqual({ status: 'present', other: 0 });
});

it('join and leave work beside an unrelated damaged binding without deleting it', () => {
  const damaged = oldBinding(root);
  fs.writeFileSync(damaged, '{');
  const bytes = fs.readFileSync(damaged);
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  writeRegistryEntry(entry(other), { mycoHome });
  expect(readRegistryEntryResult(other, mycoHome).status).toBe('present');
  expect(readRegistryEntryResult(path.join(base, 'Unbound'), mycoHome).status).toBe('missing');
  expect(removeRegistryEntry(other, mycoHome)).toBe(true);
  expect(fs.readFileSync(damaged)).toEqual(bytes);
});

it('an explicit re-join after an ancestor move succeeds in a fresh process', () => {
  writeRegistryEntry(entry(root), { mycoHome });
  const moved = path.join(base, 'Moved');
  fs.renameSync(path.dirname(root), moved);
  fs.symlinkSync(moved, path.dirname(root), 'junction');
  const source = 'import {writeRegistryEntry,readRegistryEntryResult} from '
    + JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))
    + '; writeRegistryEntry(' + JSON.stringify(entry(root, 'https://personal.invalid', 'proj_rejoined'))
    + ',{mycoHome:' + JSON.stringify(mycoHome) + ',resolveConflict:true}); const r=readRegistryEntryResult('
    + JSON.stringify(root) + ',' + JSON.stringify(mycoHome) + '); console.log(r.status==="present"?r.entry.projectId:r.status);';
  expect(execFileSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e', source], { cwd: base, encoding: 'utf8' }).trim()).toBe('proj_rejoined');
});

for (const kind of ['opt-out', 'choice']) it('an orphaned ' + kind + ' stays local when its recorded symlink disappears', () => {
  defaultWork();
  const key = legacyRootKey(alias);
  if (kind === 'opt-out') markLeft(key, mycoHome, 1, { repository: { root: alias } });
  else {
    writeAutoJoinState({ root: alias, rootKey: key, label: 'Repo', outcome: 'outside_folders', serverUrl: 'https://work.invalid', attemptAt: 1 }, mycoHome);
    cacheMachineSettings('https://work.invalid', { leaves: { 'capture.connect_roots': { [key]: 'proj_old' } } }, mycoHome);
  }
  fs.unlinkSync(path.join(base, 'alias'));
  const other = path.join(base, 'Unrelated');
  fs.mkdirSync(other);
  execFileSync('git', ['init', '-q'], { cwd: other });
  const held = autoJoinHold({ root: other, hookName: 'session-end', agent: 'claude-code', sessionId: 'other', mycoHome, now: 2,
    env: { MYCO_TEMPORARY_FOLDERS: path.join(base, 'excluded') }, later: () => {} });
  expect(held).not.toBeNull();
  expect(held).not.toBe(LEFT_ALONE);
  expect(typeof held === 'object' && held?.spool).toBeTruthy();
});

it('a new legacy alias invalidates the clean registry proof before a conflicting lookup', () => {
  writeRegistryEntry(entry(root), { mycoHome });
  oldBinding(alias, 'https://work.invalid', 'proj_work');
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('unavailable');
  expect(listRegistryEntriesResult(mycoHome).conflicts).toHaveLength(1);
});

it('filesystem-only alias conflicts invalidate the clean registry proof', () => {
  const other = path.join(base, 'Other', 'Repo');
  fs.mkdirSync(other, { recursive: true });
  writeRegistryEntry(entry(root), { mycoHome });
  writeRegistryEntry(entry(other, 'https://work.invalid', 'proj_work'), { mycoHome });
  fs.rmSync(other, { recursive: true });
  fs.symlinkSync(root, other, 'junction');
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('unavailable');
  expect(listRegistryEntriesResult(mycoHome).conflicts).toHaveLength(1);
});

it('an in-place foreign-root claim is malformed for its own canonical binding only', () => {
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  writeRegistryEntry(entry(root), { mycoHome });
  writeRegistryEntry(entry(other, 'https://work.invalid', 'proj_work'), { mycoHome });
  const file = registryEntryPath(other, mycoHome);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...value, root: canonicalRootIdentity(root), displayRoot: canonicalRootIdentity(other) }));
  expect(readRegistryEntryResult(root, mycoHome).status).toBe('present');
  expect(readRegistryEntryResult(other, mycoHome).status).toBe('unavailable');
  expect(listRegistryEntriesResult(mycoHome)).toMatchObject({ entries: [{ projectId: 'proj_personal' }], unavailableEntries: 1 });
  expect(listRegistryEntriesResult(mycoHome).conflicts ?? []).toHaveLength(0);
});

it('a historical held spelling is discovered without state records and cached across receipt reads', () => {
  const generic = fs.realpathSync.bind(fs);
  const native = fs.realpathSync.native;
  const spelling = spyOn(fs, 'realpathSync').mockImplementation(((at: fs.PathLike) => String(at) === alias ? alias : generic(at)) as typeof fs.realpathSync);
  Object.assign(fs.realpathSync, { native });
  try {
    heldAlias();
    const live = new MemberSpool(entry(root), { mycoHome });
    restoreHeldReceiptsForHook(root, 'held-alias', live, { mycoHome, now: Date.now() });
    expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBe('prompt-old-key');
    const scan = spyOn(fs, 'readdirSync');
    try {
      restoreHeldReceiptsForHook(root, 'held-alias', live, { mycoHome, now: Date.now() });
      expect(scan.mock.calls.some(([at]) => String(at) === path.dirname(pendingDir(legacyRootKey(alias), mycoHome, 'https://personal.invalid')))).toBe(false);
    } finally { scan.mockRestore(); }
  } finally { spelling.mockRestore(); }
});

it('malformed held identity proofs are rebuilt before receipt recovery', () => {
  const held = heldAlias();
  const live = new MemberSpool(entry(root), { mycoHome });
  restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts);
  const file = path.join(mycoHome, 'member/pending-identities', deploymentKeyFor(held.repo.serverUrl));
  const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete proof.aliases;
  fs.writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
  expect(() => restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts)).not.toThrow();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).aliases).toBeDefined();
});

it('unreadable held metadata does not certify an incomplete identity index', () => {
  const held = heldAlias();
  const live = new MemberSpool(entry(root), { mycoHome });
  const file = path.join(pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl), 'pending.json');
  const read = fs.readFileSync.bind(fs);
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((at: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(at) === file) throw Object.assign(new Error('unavailable metadata'), { code: 'EACCES' });
    return (read as (...args: unknown[]) => unknown)(at, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(() => restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts)).toThrow();
    expect(fs.existsSync(path.join(mycoHome, 'member/pending-identities', deploymentKeyFor(held.repo.serverUrl)))).toBe(false);
  } finally { spy.mockRestore(); }
  restoreHeldReceiptsForHook(root, 'held-alias', live, held.opts);
  expect(readSessionState(live.dir, 'held-alias').prompts.receipt).toBe('prompt-old-key');
});

it('joining beside a deleted unrelated repository parent does not fail during cache certification', () => {
  const other = path.join(base, 'DeletedParent', 'Repo');
  fs.mkdirSync(other, { recursive: true });
  writeRegistryEntry(entry(other, 'https://work.invalid', 'proj_work'), { mycoHome });
  fs.rmSync(path.dirname(other), { recursive: true });
  expect(() => writeRegistryEntry(entry(root, 'https://personal.invalid', 'proj_updated'), { mycoHome })).not.toThrow();
  expect(readRegistryEntry(root, mycoHome)?.projectId).toBe('proj_updated');
});

it('leaving preserves unrelated damaged held metadata and capture', async () => {
  const other = path.join(base, 'OtherHeld');
  fs.mkdirSync(other);
  const held = heldAlias('https://personal.invalid', other);
  const dir = pendingDir(held.repo.rootKey, mycoHome, held.repo.serverUrl);
  const bytes = fs.readFileSync(path.join(dir, 'held-alias.jsonl'));
  fs.writeFileSync(path.join(dir, 'pending.json'), '{damaged', { mode: 0o600 });
  await optOut(root, null, { mycoHome, now: held.opts.now });
  expect(fs.readFileSync(path.join(dir, 'held-alias.jsonl'))).toEqual(bytes);
  expect(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8')).toBe('{damaged');
});

for (const shape of ['root-file', 'deployment-file']) it('an unrelated held ' + shape + ' cannot abort leave or replay', async () => {
  const held = heldAlias();
  const dir = pendingDir('d'.repeat(32), mycoHome, held.repo.serverUrl);
  const bad = shape === 'root-file' ? dir : path.join(path.dirname(path.dirname(dir)), deploymentKeyFor('https://unrelated.invalid'));
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'unrelated bytes', { mode: 0o600 });
  expect(flushHeldCapture(root, entry(root), held.opts)).toBe(1);
  await optOut(root, null, { mycoHome, now: held.opts.now });
  expect(fs.readFileSync(bad, 'utf8')).toBe('unrelated bytes');
});

it('a malformed held directory for this repository still fails closed', async () => {
  const key = rootKeyFor(root, mycoHome);
  const dir = pendingDir(key, mycoHome, 'https://personal.invalid');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'own unavailable capture', { mode: 0o600 });
  await expect(optOut(root, null, { mycoHome, now: Date.now() })).rejects.toThrow('directory unavailable');
  expect(fs.readFileSync(dir, 'utf8')).toBe('own unavailable capture');
});
