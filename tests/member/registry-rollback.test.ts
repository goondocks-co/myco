import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistryEntry, readRegistryEntryResult, listRegistryEntriesResult, projectsDir, registryEntryPath, writeDeploymentMembership, writeRegistryEntry, removeRegistryEntry, acquireRegistryLock, withRegistryLock, logoutBindings, removeDeploymentForLogout, readDeploymentMembership, membershipTokenDigest } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { ensureMemberDir } from '@myco/member/store.js';
import { canonicalRootIdentity } from '@myco/utils/git-files.js';

let base: string;
let home: string;
let root: string;
let alias: string;
let previous: string;
const fixture = path.resolve('tests/fixtures/member-rollback');
const oldKey = (at: string) => crypto.createHash('sha256').update(path.resolve(at)).digest('hex').slice(0, 16);
const binding = (at: string, projectId = 'proj_personal') => ({ version: 2, root: at, projectId, serverUrl: 'https://personal.invalid', joinedAt: 1, updatedAt: 1 });
const oldFile = () => path.join(projectsDir(home), oldKey(alias) + '.json');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-rollback-'));
  home = path.join(base, 'home');
  root = path.join(base, 'Physical', 'Repo');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.symlinkSync(path.dirname(root), path.join(base, 'alias'), 'junction');
  alias = path.join(base, 'alias', 'Repo');
  previous = path.join(base, 'previous-member.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8')) as { bundle: string; sha256: string };
  const content = fs.readFileSync(path.join(fixture, manifest.bundle));
  expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(manifest.sha256);
  fs.writeFileSync(previous, content);
  writeDeploymentMembership({ serverUrl: 'https://personal.invalid', token: 'P'.repeat(43), machineId: 'fake', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  writeDeploymentMembership({ serverUrl: 'https://work.invalid', token: 'W'.repeat(43), machineId: 'fake', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  recordDefaultDeployment('https://work.invalid', { mycoHome: home });
  ensureMemberDir(projectsDir(home), home);
  fs.writeFileSync(oldFile(), JSON.stringify(binding(alias)), { mode: 0o600 });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

function previousHook() {
  return hookAnswer('import {readRegistryEntryResult,resolveCredential,autoJoinHold} from ' + JSON.stringify(previous));
}

function currentHook() {
  return hookAnswer('import {readRegistryEntryResult} from ' + JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))
    + ';import {resolveCredential} from ' + JSON.stringify(path.resolve('packages/myco/src/member/credential.ts'))
    + ';import {autoJoinHold} from ' + JSON.stringify(path.resolve('packages/myco/src/member/auto-join-hook.ts')));
}

function hookAnswer(imports: string) {
  const source = imports + '; const root=' + JSON.stringify(alias) + ',mycoHome=' + JSON.stringify(home)
    + '; const env={MYCO_TEMPORARY_FOLDERS:' + JSON.stringify(path.join(base, 'excluded')) + '}; let held=null,queued=0;'
    + 'const result=readRegistryEntryResult(root,mycoHome); const credential=resolveCredential("registry",{cwd:root,mycoHome,env,claimsUnconnected:(at)=>{'
    + 'held=autoJoinHold({root:at,mycoHome,now:2,hookName:"session-end",agent:"claude-code",sessionId:"rollback",env,later:()=>queued++});return held!==null;}});'
    + 'console.log(JSON.stringify({status:result.status,server:credential?.serverUrl??null,held:held?.repo?.serverUrl??null,queued}));';
  return JSON.parse(execFileSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e', source], { cwd: base, encoding: 'utf8' })) as { status: string; server: string | null; held: string | null; queued: number };
}

function conflictingConnection() {
  fs.writeFileSync(registryEntryPath(root, home), JSON.stringify({ ...binding(canonicalRootIdentity(root), 'proj_work'), version: 3, serverUrl: 'https://work.invalid' }), { mode: 0o600 });
  expect(readRegistryEntryResult(root, home).status).toBe('unavailable');
  return { ...binding(alias), token: 'P'.repeat(43), machineId: 'fake' };
}

function expectChosenOrConflict(answer: ReturnType<typeof currentHook>) {
  expect(['unavailable', 'present']).toContain(answer.status);
  expect([null, 'https://personal.invalid']).toContain(answer.server);
  expect(answer.held).toBeNull();
  expect(answer.queued).toBe(0);
}

it('a fresh concurrent hook never sees the rejected Deployment during conflict repair', () => {
  const chosen = conflictingConnection();
  const target = registryEntryPath(root, home);
  const rename = fs.renameSync;
  let observed = false;
  const fault = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) {
      observed = true;
      expectChosenOrConflict(currentHook());
    }
    return rename(from, to);
  }) as typeof fs.renameSync);
  try { writeRegistryEntry(chosen, { mycoHome: home, resolveConflict: true }); }
  finally { fault.mockRestore(); }
  expect(observed).toBe(true);
  expect(currentHook().server).toBe('https://personal.invalid');
});

for (const edge of ['before', 'after']) it.skipIf(process.platform === 'win32')('SIGKILL ' + edge + ' conflict repair publication never exposes the rejected Deployment (POSIX termination required)', () => {
  const chosen = conflictingConnection();
  const source = 'import fs from "node:fs";import {writeRegistryEntry} from ' + JSON.stringify(path.resolve('packages/myco/src/member/registry.ts'))
    + ';const target=' + JSON.stringify(registryEntryPath(root, home)) + ',rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to)!==target)return rename(from,to);'
    + (edge === 'after' ? 'rename(from,to);' : '') + 'process.kill(process.pid,"SIGKILL");};writeRegistryEntry('
    + JSON.stringify(chosen) + ',{mycoHome:' + JSON.stringify(home) + ',resolveConflict:true});';
  const killed = spawnSync(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), '-e', source], { cwd: base, encoding: 'utf8' });
  expect(killed.signal).toBe('SIGKILL');
  expectChosenOrConflict(currentHook());
});

it('the previous reader and automatic connection path fail closed after canonical migration', () => {
  expect(previousHook()).toEqual({ status: 'present', server: 'https://personal.invalid', held: null, queued: 0 });
  expect(readRegistryEntry(alias, home)?.serverUrl).toBe('https://personal.invalid');
  expect(previousHook()).toEqual({ status: 'unavailable', server: null, held: null, queued: 0 });
  expect(JSON.parse(fs.readFileSync(oldFile(), 'utf8'))).toEqual({ version: 0, kind: 'canonical-root', root: canonicalRootIdentity(root), displayRoot: alias });
  expect(listRegistryEntriesResult(home)).toMatchObject({ readable: true, unavailableEntries: 0 });
  expect(listRegistryEntriesResult(home).entries).toHaveLength(1);
  expect(listRegistryEntriesResult(home).conflicts).toBeUndefined();
});

it('the previous automatic connection path holds an unbound repository for its default', () => {
  fs.unlinkSync(oldFile());
  const answer = previousHook();
  expect(answer.status).toBe('missing');
  expect(answer.held).toBe('https://work.invalid');
  expect(answer.queued).toBeGreaterThan(0);
});

for (const publish of ['canonical', 'stub']) for (const edge of ['before', 'after']) {
  it('a crash ' + edge + ' the ' + publish + ' publication never loses the previous reader destination', () => {
    const target = publish === 'canonical' ? registryEntryPath(alias, home) : oldFile();
    const rename = fs.renameSync;
    let interrupted = false;
    const fault = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== target) return rename(from, to);
      const lease = acquireRegistryLock(home);
      if (lease.acquired) lease.lock.release();
      expect(lease.acquired).toBe(false);
      interrupted = true;
      if (edge === 'after') rename(from, to);
      throw new Error('interrupted publication');
    }) as typeof fs.renameSync);
    try { expect(() => readRegistryEntry(alias, home)).toThrow('interrupted publication'); }
    finally { fault.mockRestore(); }
    expect(interrupted).toBe(true);
    const answer = previousHook();
    expect(answer.status).toBe(publish === 'stub' && edge === 'after' ? 'unavailable' : 'present');
    expect(answer.held).toBeNull();
    expect(answer.queued).toBe(0);
    expect(readRegistryEntry(alias, home)?.projectId).toBe('proj_personal');
    expect(previousHook().status).toBe('unavailable');
  });
}

it('explicit join replaces a stub with the selected connection and leave removes only that repository', () => {
  readRegistryEntry(alias, home);
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  writeRegistryEntry({ ...binding(other), token: 'P'.repeat(43), machineId: 'fake' }, { mycoHome: home });
  writeRegistryEntry({ ...binding(root, 'proj_selected'), token: 'P'.repeat(43), machineId: 'fake' }, { mycoHome: home, resolveConflict: true });
  expect(JSON.parse(fs.readFileSync(oldFile(), 'utf8'))).toMatchObject({ version: 2, projectId: 'proj_selected' });
  expect(previousHook()).toEqual({ status: 'present', server: 'https://personal.invalid', held: null, queued: 0 });
  expect(readRegistryEntry(alias, home)?.projectId).toBe('proj_selected');
  expect(removeRegistryEntry(root, home)).toBe(true);
  expect(JSON.parse(fs.readFileSync(oldFile(), 'utf8'))).toMatchObject({ version: 0, kind: 'left-root' });
  expect(previousHook()).toEqual({ status: 'unavailable', server: null, held: null, queued: 0 });
  expect(readRegistryEntryResult(root, home).status).toBe('missing');
  expect(readRegistryEntry(other, home)?.projectId).toBe('proj_personal');
});

it('an orphaned stub is unavailable for its repository and invisible in listings', () => {
  readRegistryEntry(alias, home);
  fs.unlinkSync(registryEntryPath(root, home));
  expect(readRegistryEntryResult(alias, home).status).toBe('unavailable');
  expect(readRegistryEntryResult(root, home).status).toBe('unavailable');
  expect(listRegistryEntriesResult(home)).toEqual({ entries: [], readable: true, unavailableEntries: 0 });
});

it('Deployment logout disconnects a migrated repository while preserving the previous reader refusal', () => {
  readRegistryEntry(alias, home);
  withRegistryLock(() => {
    const membership = readDeploymentMembership('https://personal.invalid', home)!;
    removeDeploymentForLogout(membership.serverUrl, membershipTokenDigest(membership), logoutBindings(home), home);
  }, home);
  expect(readRegistryEntryResult(root, home).status).toBe('missing');
  expect(JSON.parse(fs.readFileSync(oldFile(), 'utf8'))).toMatchObject({ version: 0, kind: 'left-root' });
  expect(previousHook()).toEqual({ status: 'unavailable', server: null, held: null, queued: 0 });
  expect(listRegistryEntriesResult(home)).toEqual({ entries: [], readable: true, unavailableEntries: 0 });
});

it('targeted logout preserves another Deployment binding exposed during cleanup', () => {
  readRegistryEntry(alias, home);
  withRegistryLock(() => {
    const membership = readDeploymentMembership('https://personal.invalid', home)!;
    removeDeploymentForLogout(membership.serverUrl, membershipTokenDigest(membership), logoutBindings(home), home, () => {
      fs.writeFileSync(oldFile(), JSON.stringify({ ...binding(alias, 'proj_work'), serverUrl: 'https://work.invalid' }));
    });
  }, home);
  expect(readRegistryEntry(root, home)?.serverUrl).toBe('https://work.invalid');
  expect(readDeploymentMembership('https://work.invalid', home)?.serverUrl).toBe('https://work.invalid');
});

it('a stub edited in place into a disagreeing binding invalidates the canonical proof', () => {
  readRegistryEntry(alias, home);
  expect(fs.existsSync(path.join(home, 'member', 'registry-canonical'))).toBe(true);
  fs.writeFileSync(oldFile(), JSON.stringify(binding(alias, 'proj_other')));
  expect(readRegistryEntryResult(root, home).status).toBe('unavailable');
  expect(listRegistryEntriesResult(home).conflicts).toHaveLength(1);
});
