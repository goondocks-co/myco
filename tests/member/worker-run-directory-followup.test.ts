import { expect, it, spyOn } from 'bun:test';
import fs from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunDir, discardRunDir } from '@myco/runner/mcp-config.js';
import * as directories from '@myco/runner/run-directory.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const CONNECTION = { serverUrl: 'https://fixture.invalid', projectId: 'project-test', runToken: 'synthetic-run-secret' };
const root = () => removeWhenTestsEnd(fs.mkdtempSync(join(tmpdir(), 'myco-directory-followup-')));
const manifestOf = (path: string) => JSON.parse(fs.readFileSync(join(path, directories.RUN_DIRECTORY_MANIFEST), 'utf8'));
const old = (path: string) => {
  const past = new Date(Date.now() - 2 * directories.LEGACY_RUN_DIRECTORY_AGE_MS);
  fs.utimesSync(path, past, past);
};
function prior(path: string, fields: Record<string, unknown> = {}) {
  const { machineId: _machineId, ...manifest } = manifestOf(path);
  fs.writeFileSync(join(path, directories.RUN_DIRECTORY_MANIFEST), JSON.stringify({ ...manifest, version: 1, hostname: 'old-network-hostname', ...fields }));
}
const absent = () => { throw Object.assign(new Error('absent synthetic owner'), { code: 'ESRCH' }); };

it('allocates stable-machine ownership under a distinct manifest version', () => {
  const path = writeRunDir(root(), 'run_version', CONNECTION).scratchDir;
  try { expect(manifestOf(path)).toMatchObject({ version: 2 }); }
  finally { discardRunDir(path); }
});

it('retires an old valid hostname-only manifest after a hostname change while preserving unknown contents', () => {
  const runs = root();
  const empty = writeRunDir(runs, 'run_prior', CONNECTION).scratchDir;
  const unknown = writeRunDir(runs, 'run_prior_unknown', CONNECTION).scratchDir;
  fs.writeFileSync(join(unknown, 'keep.txt'), 'unknown-content');
  for (const path of [empty, unknown]) { prior(path, { pid: process.pid + 1_000_100 }); old(path); }
  const probe = spyOn(process, 'kill').mockImplementation((_, signal) => { expect(signal).toBe(0); return absent(); });
  try {
    expect(directories.recoverAbandonedRunDirectories(runs).recovered).toBe(1);
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.existsSync(join(unknown, 'mcp.json'))).toBe(false);
    expect(fs.readFileSync(join(unknown, 'keep.txt'), 'utf8')).toBe('unknown-content');
  } finally { probe.mockRestore(); }
});

it('preserves young, live, foreign, uncertain and unfinished prior manifests', () => {
  const runs = root();
  const cases = ['young', 'live-worker', 'live-group', 'pending', 'foreign-machine', 'foreign-platform', 'uncertain-worker', 'uncertain-group', 'malformed'];
  const paths = cases.map((name, index) => {
    const path = writeRunDir(runs, `run_${name}`, CONNECTION).scratchDir;
    const pid = process.pid + 1_000_200 + index;
    const fields: Record<string, unknown> = { pid, processGroups: [pid + 100] };
    if (name === 'pending') fields.pendingStarts = ['unfinished'];
    if (name === 'foreign-machine') fields.machineId = 'another-machine';
    if (name === 'foreign-platform') fields.platform = process.platform === 'win32' ? 'darwin' : 'win32';
    if (name === 'malformed') fields.pendingStarts = 0;
    prior(path, fields);
    if (name !== 'young') old(path);
    return path;
  });
  const probe = spyOn(process, 'kill').mockImplementation((target, signal) => {
    expect(signal).toBe(0);
    const pid = Math.abs(target);
    if (pid === process.pid + 1_000_201 || pid === process.pid + 1_000_302) return true;
    if (pid === process.pid + 1_000_206 || pid === process.pid + 1_000_307) throw Object.assign(new Error('uncertain owner'), { code: 'EPERM' });
    return absent();
  });
  try {
    expect(directories.recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    for (const path of paths) expect(fs.readFileSync(join(path, 'mcp.json'), 'utf8')).toContain(CONNECTION.runToken);
  } finally { probe.mockRestore(); }
});

it('continues every pending discard after a persistent filesystem failure and surfaces aggregate failures', () => {
  const runs = root();
  const first = writeRunDir(runs, 'run_first', CONNECTION).scratchDir;
  const later = writeRunDir(runs, 'run_later', CONNECTION).scratchDir;
  const locked = join(first, 'locked.txt');
  fs.writeFileSync(locked, 'locked-content');
  const pid = process.pid + 1_000_400;
  let alive = true;
  const probe = spyOn(process, 'kill').mockImplementation((_, signal) => { expect(signal).toBe(0); return alive ? true : absent(); });
  const original = fs.rmSync;
  const removal = spyOn(fs, 'rmSync').mockImplementation((at, options) => {
    if (String(at) === locked) throw Object.assign(new Error('persistent locked entry'), { code: 'EPERM' });
    return original(at, options);
  });
  try {
    expect(() => discardRunDir(first)).toThrow();
    directories.beginRunProcess(later)!.started(pid);
    expect(() => discardRunDir(later)).toThrow('still has a harness owner');
    alive = false;
    expect(() => directories.retryPendingRunDirectoryDiscards()).toThrow(AggregateError);
    expect(fs.existsSync(join(later, 'mcp.json'))).toBe(false);
    expect(fs.existsSync(later)).toBe(false);
    expect(fs.existsSync(join(first, directories.RUN_DIRECTORY_MANIFEST))).toBe(true);
  } finally {
    removal.mockRestore();
    alive = false;
    discardRunDir(first);
    discardRunDir(later);
    probe.mockRestore();
  }
});

it('guards child entry deletion with allocation ownership and queues a live owner for whole-allocation retry', () => {
  const path = writeRunDir(root(), 'run_entry', CONNECTION).scratchDir;
  const repo = join(path, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(join(repo, 'source.txt'), 'synthetic-source');
  const pid = process.pid + 1_000_500;
  directories.beginRunProcess(path)!.started(pid);
  let alive = true;
  const probe = spyOn(process, 'kill').mockImplementation((_, signal) => { expect(signal).toBe(0); return alive ? true : absent(); });
  try {
    expect(() => directories.removeOwnedRunDirectoryEntry(path, 'repo')).toThrow('still has a harness owner');
    expect(fs.readFileSync(join(repo, 'source.txt'), 'utf8')).toBe('synthetic-source');
    expect(fs.readFileSync(join(path, 'mcp.json'), 'utf8')).toContain(CONNECTION.runToken);
    alive = false;
    expect(directories.retryPendingRunDirectoryDiscards().recovered).toBe(1);
    expect(fs.existsSync(path)).toBe(false);
  } finally { alive = false; discardRunDir(path); probe.mockRestore(); }
});

it('removes only an owned direct child and refuses traversal, manifest deletion and foreign ownership', () => {
  const path = writeRunDir(root(), 'run_entry_validation', CONNECTION).scratchDir;
  const target = root();
  fs.writeFileSync(join(target, 'keep.txt'), 'outside-content');
  fs.symlinkSync(target, join(path, 'repo'));
  try {
    directories.removeOwnedRunDirectoryEntry(path, 'repo');
    expect(fs.existsSync(join(path, 'repo'))).toBe(false);
    expect(fs.readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('outside-content');
    expect(fs.readFileSync(join(path, 'mcp.json'), 'utf8')).toContain(CONNECTION.runToken);
    for (const entry of ['', '.', '..', '../outside', 'repo/source.txt', 'repo\\source.txt', directories.RUN_DIRECTORY_MANIFEST]) {
      expect(() => directories.removeOwnedRunDirectoryEntry(path, entry)).toThrow('Invalid run directory entry');
    }
    expect(() => directories.removeOwnedRunDirectoryEntry(target, 'keep.txt')).toThrow('belongs to another owner');
    expect(fs.readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('outside-content');
  } finally { discardRunDir(path); }
});
