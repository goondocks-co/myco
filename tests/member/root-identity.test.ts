import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireRegistryLock, listRegistryEntriesResult, projectsDir, readRegistryEntry, readRegistryEntryResult,
  registryEntryPath, registryKeyFor, REGISTRY_VERSION, writeDeploymentMembership, writeRegistryEntry, type RegistryEntry,
} from '@myco/member/registry.js';
import { canonicalRootIdentity } from '@myco/utils/git-files.js';
import { resolveMemberProjectRoot, resolveCredential } from '@myco/member/credential.js';
import { rootKeyFor, listJoinRequests } from '@myco/member/auto-join.js';
import { autoJoinHold } from '@myco/member/auto-join-hook.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { listPending, pendingSpool } from '@myco/member/pending.js';
import { runStatus, runMcpHeaders } from '@myco/cli/member.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { runAutoJoin } from '@myco/cli/member-auto-join.js';
import { runHook } from './helpers/hooks.js';
import { ensureMemberDir } from '@myco/member/store.js';
import { attributeTranscript } from '@myco/symbionts/transcript-attribution.js';


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
  return execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + at + '") do @echo %~sI'], { encoding: 'utf8' }).trim();
}
function supportsShortNames(): boolean {
  if (process.platform !== 'win32') return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-short-name-'));
  try { return /~[0-9]/.test(windowsShortPath(probe)); }
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
  expect(fs.existsSync(old)).toBe(false);
  const stored = JSON.parse(fs.readFileSync(registryEntryPath(root, mycoHome), 'utf8'));
  expect(stored.root).toBe(canonicalRootIdentity(root));
  expect(stored.displayRoot).toBe(alias);
});
it('a crash after the canonical write leaves both readable; the next read removes only the duplicate', () => {
  const old = oldBinding(alias);
  const unlink = fs.unlinkSync;
  const crash = spyOn(fs, 'unlinkSync').mockImplementation((at) => {
    if (String(at) === old) throw new Error('simulated crash after write');
    return unlink(at);
  });
  try { expect(() => readRegistryEntry(root, mycoHome)).toThrow('simulated crash'); }
  finally { crash.mockRestore(); }
  expect(fs.existsSync(old)).toBe(true);
  expect(fs.existsSync(registryEntryPath(root, mycoHome))).toBe(true);
  expect(readRegistryEntryResult(alias, mycoHome).status).toBe('present');
  expect(readRegistryEntry(root, mycoHome)?.serverUrl).toBe('https://personal.invalid');
  expect(fs.existsSync(old)).toBe(false);
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
  await aliasGate([root, windowsShortPath(root), alias]);
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
  it.skipIf(process.platform === 'win32' && damage === 'loose-mode' || !fileLinks && damage === 'outside-link')('a ' + damage + ' old alias entry stays unavailable from every spelling and cannot join the default Myco (mode and file-link variants require host support)', () => {
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
    for (const at of [root, alias]) {
      expect(readRegistryEntryResult(at, mycoHome, { upgrade: true }).status).toBe('unavailable');
      expect(autoJoinHold({ root: at, hookName: 'session-start', agent: 'claude-code', sessionId: 'damaged', mycoHome, now: 1, env: {}, later: () => { throw new Error('must not join'); } })).toBeNull();
    }
    expect(() => writeRegistryEntry(entry(root), { mycoHome })).toThrow('could not all be read');
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
  expect(fs.existsSync(oldPath(alias))).toBe(false);
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
  const preservesCase = spyOn(fs.realpathSync, 'native').mockImplementation(((at: fs.PathLike) =>
    String(at) === variant ? variant : native(at)) as typeof fs.realpathSync.native);
  try {
    expect(attributeTranscript('claude-code', transcript, [root], { git: { mainCheckout: cwd => cwd } })).toEqual({ kind: 'bound', root });
  } finally { preservesCase.mockRestore(); }
});
