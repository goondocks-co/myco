import { describe, expect, it, spyOn } from 'bun:test';
import fs from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from '../support/fenced-fs.mjs';
import { writeRunDir, discardRunDir } from '@myco/runner/mcp-config.js';
import * as directories from '@myco/runner/run-directory.js';
import { getMachineId } from '@myco/machine-id.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'project-test', runToken: 'synthetic-run-secret' };
const root = () => removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-home-corrections-')));
const manifestOf = (path: string) => JSON.parse(readFileSync(join(path, directories.RUN_DIRECTORY_MANIFEST), 'utf8'));
const replaceManifest = (path: string, fields: Record<string, unknown>) => writeFileSync(join(path, directories.RUN_DIRECTORY_MANIFEST), JSON.stringify({ ...manifestOf(path), ...fields }));
const dead = (pid: number) => spyOn(process, 'kill').mockImplementation((target, signal) => {
  if (target === pid && signal === 0) throw Object.assign(new Error('absent synthetic owner'), { code: 'ESRCH' });
  throw new Error('Unexpected process probe.');
});

describe('run home correction gates', () => {
  it('uses persisted machine identity after a hostname change and preserves foreign machine identity', () => {
    const runs = root();
    const local = writeRunDir(runs, 'run_local', CONNECTION).scratchDir;
    const foreign = writeRunDir(runs, 'run_foreign', CONNECTION).scratchDir;
    const pid = process.pid + 1_000_000;
    replaceManifest(local, { machineId: getMachineId(), hostname: 'changed-network-name', pid });
    replaceManifest(foreign, { machineId: 'another-machine', pid });
    const probe = dead(pid);
    try {
      expect(directories.recoverAbandonedRunDirectories(runs)).toMatchObject({ recovered: 1 });
      expect(existsSync(local)).toBe(false);
      expect(readFileSync(join(foreign, 'mcp.json'), 'utf8')).toContain(CONNECTION.runToken);
    } finally { probe.mockRestore(); }
  });

  it('sweeps only old legacy credential files under the run root and preserves unknown contents and symlink targets', () => {
    const runs = root();
    const outside = root();
    writeFileSync(join(outside, 'auth.json'), 'synthetic-login-target');
    const old = join(runs, 'run_legacy');
    const unknown = join(runs, 'run_unknown');
    const young = join(runs, 'run_young');
    const linkedHome = join(runs, 'run_linked_home');
    for (const path of [old, unknown, young]) {
      mkdirSync(join(path, 'codex-home'), { recursive: true });
      writeFileSync(join(path, 'mcp.json'), 'synthetic-run-secret');
      writeFileSync(join(path, 'codex-home', 'config.toml'), 'synthetic-run-secret');
      symlinkSync(join(outside, 'auth.json'), join(path, 'codex-home', 'auth.json'));
    }
    writeFileSync(join(unknown, 'keep.txt'), 'unknown-owned-content');
    mkdirSync(linkedHome);
    writeFileSync(join(linkedHome, 'mcp.json'), 'synthetic-run-secret');
    symlinkSync(outside, join(linkedHome, 'codex-home'));
    symlinkSync(outside, join(runs, 'linked'));
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    for (const path of [old, unknown, linkedHome]) utimesSync(path, past, past);
    directories.recoverAbandonedRunDirectories(runs);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(unknown, 'keep.txt'), 'utf8')).toBe('unknown-owned-content');
    expect(existsSync(join(unknown, 'mcp.json'))).toBe(false);
    expect(existsSync(join(unknown, 'codex-home', 'config.toml'))).toBe(false);
    expect(readFileSync(join(young, 'mcp.json'), 'utf8')).toBe('synthetic-run-secret');
    expect(existsSync(join(linkedHome, 'mcp.json'))).toBe(false);
    expect(readFileSync(join(outside, 'auth.json'), 'utf8')).toBe('synthetic-login-target');
  });

  it('retries an owned discard after its harness owner exits in the same worker', () => {
    const path = writeRunDir(root(), 'run_retry', CONNECTION).scratchDir;
    const pid = process.pid + 1_000_001;
    const launch = directories.beginRunProcess(path)!;
    launch.started(pid);
    let alive = true;
    const probe = spyOn(process, 'kill').mockImplementation((target, signal) => {
      expect(target).toBe(process.platform === 'win32' ? pid : -pid);
      expect(signal).toBe(0);
      if (alive) return true;
      throw Object.assign(new Error('absent synthetic owner'), { code: 'ESRCH' });
    });
    try {
      expect(() => discardRunDir(path)).toThrow('still has a harness owner');
      expect(readFileSync(join(path, 'mcp.json'), 'utf8')).toContain(CONNECTION.runToken);
      alive = false;
      directories.recoverAbandonedRunDirectories(join(path, '..'));
      expect(existsSync(path)).toBe(false);
    } finally { probe.mockRestore(); }
  });

  it('scrubs credentials before an unrelated directory-removal failure and retains retry ownership', () => {
    const path = writeRunDir(root(), 'run_locked', CONNECTION).scratchDir;
    mkdirSync(join(path, 'codex-home'));
    writeFileSync(join(path, 'codex-home', 'config.toml'), 'synthetic-provider-secret');
    writeFileSync(join(path, 'locked.txt'), 'locked-unknown-content');
    const original = fs.rmSync;
    let scrubbedBeforeFailure = false;
    const removal = spyOn(fs, 'rmSync').mockImplementation((at, options) => {
      if (String(at) === join(path, 'locked.txt')) {
        scrubbedBeforeFailure = !existsSync(join(path, 'mcp.json')) && !existsSync(join(path, 'codex-home', 'config.toml'));
        throw Object.assign(new Error('locked entry'), { code: 'EPERM' });
      }
      return original(at, options);
    });
    try {
      expect(() => discardRunDir(path)).toThrow('Run directory cleanup failed');
      expect(scrubbedBeforeFailure).toBe(true);
      expect(existsSync(join(path, 'mcp.json'))).toBe(false);
      expect(existsSync(join(path, 'codex-home', 'config.toml'))).toBe(false);
      expect(existsSync(join(path, directories.RUN_DIRECTORY_MANIFEST))).toBe(true);
    } finally { removal.mockRestore(); }
    discardRunDir(path);
    expect(existsSync(path)).toBe(false);
  });

  it('rewrites a credential empty when file deletion is denied and never rewrites a symlink target', () => {
    const path = writeRunDir(root(), 'run_scrub', CONNECTION).scratchDir;
    const outside = root();
    writeFileSync(join(outside, 'auth.json'), 'synthetic-login-target');
    mkdirSync(join(path, 'codex-home'));
    symlinkSync(join(outside, 'auth.json'), join(path, 'codex-home', 'auth.json'));
    writeFileSync(join(path, 'codex-home', 'config.toml'), 'synthetic-provider-secret');
    const originalUnlink = fs.unlinkSync;
    const originalRm = fs.rmSync;
    const deny = () => { throw Object.assign(new Error('locked credential'), { code: 'EPERM' }); };
    const unlink = spyOn(fs, 'unlinkSync').mockImplementation((at) => String(at) === join(path, 'mcp.json') ? deny() : originalUnlink(at));
    const removal = spyOn(fs, 'rmSync').mockImplementation((at, options) => String(at) === join(path, 'mcp.json') ? deny() : originalRm(at, options));
    try {
      expect(() => discardRunDir(path)).toThrow();
      expect(readFileSync(join(path, 'mcp.json'), 'utf8')).toBe('');
      expect(existsSync(join(path, 'codex-home', 'config.toml'))).toBe(false);
      expect(readFileSync(join(outside, 'auth.json'), 'utf8')).toBe('synthetic-login-target');
    } finally { unlink.mockRestore(); removal.mockRestore(); }
    discardRunDir(path);
  });

  it('retains retry ownership when removing the empty allocation directory fails', () => {
    const path = writeRunDir(root(), 'run_directory_locked', CONNECTION).scratchDir;
    const original = fs.rmdirSync;
    const removal = spyOn(fs, 'rmdirSync').mockImplementation((at) => {
      if (String(at) === path) throw Object.assign(new Error('locked directory'), { code: 'EPERM' });
      return original(at);
    });
    try {
      expect(() => discardRunDir(path)).toThrow('locked directory');
      expect(existsSync(join(path, 'mcp.json'))).toBe(false);
      expect(manifestOf(path)).toMatchObject({ machineId: getMachineId(), pid: process.pid });
    } finally { removal.mockRestore(); }
    expect(directories.retryPendingRunDirectoryDiscards().recovered).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('scrubs other credentials when unlinking a credential symlink fails without touching its target', () => {
    const path = writeRunDir(root(), 'run_link_locked', CONNECTION).scratchDir;
    const outside = root();
    writeFileSync(join(outside, 'auth.json'), 'synthetic-login-target');
    mkdirSync(join(path, 'codex-home'));
    const link = join(path, 'codex-home', 'auth.json');
    symlinkSync(join(outside, 'auth.json'), link);
    writeFileSync(join(path, 'codex-home', 'config.toml'), 'synthetic-provider-secret');
    const original = fs.unlinkSync;
    const unlink = spyOn(fs, 'unlinkSync').mockImplementation((at) => {
      if (String(at) === link) throw Object.assign(new Error('locked login link'), { code: 'EPERM' });
      return original(at);
    });
    try {
      expect(() => discardRunDir(path)).toThrow('Run credential cleanup failed');
      expect(existsSync(join(path, 'mcp.json'))).toBe(false);
      expect(existsSync(join(path, 'codex-home', 'config.toml'))).toBe(false);
      expect(readFileSync(join(outside, 'auth.json'), 'utf8')).toBe('synthetic-login-target');
      expect(existsSync(join(path, directories.RUN_DIRECTORY_MANIFEST))).toBe(true);
    } finally { unlink.mockRestore(); }
    discardRunDir(path);
  });

  it('refuses to truncate a locked hard-linked credential while scrubbing independent credentials', () => {
    const path = writeRunDir(root(), 'run_hardlink_locked', CONNECTION).scratchDir;
    const outside = root();
    const target = join(outside, 'auth.json');
    writeFileSync(target, 'synthetic-login-target');
    mkdirSync(join(path, 'codex-home'));
    const link = join(path, 'codex-home', 'auth.json');
    fs.linkSync(target, link);
    writeFileSync(join(path, 'codex-home', 'config.toml'), 'synthetic-provider-secret');
    const original = fs.unlinkSync;
    const unlink = spyOn(fs, 'unlinkSync').mockImplementation((at) => {
      if (String(at) === link) throw Object.assign(new Error('locked login hardlink'), { code: 'EPERM' });
      return original(at);
    });
    try {
      expect(() => discardRunDir(path)).toThrow('Run credential cleanup failed');
      expect(readFileSync(target, 'utf8')).toBe('synthetic-login-target');
      expect(existsSync(join(path, 'mcp.json'))).toBe(false);
      expect(existsSync(join(path, 'codex-home', 'config.toml'))).toBe(false);
    } finally { unlink.mockRestore(); }
    discardRunDir(path);
  });
});
