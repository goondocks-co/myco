// TEST-ONLY safety net. Loaded via bunfig [test] preload for EVERY bun test run
// (root bunfig.toml: node phases + raw `bun test`/`--watch`; bunfig.dom.toml:
// jsdom phase). Two chokepoints make a test touching live config improbable and,
// if something slips, loud:
//   1. Redirect os.homedir()/userInfo()/HOME to a throwaway per-process sandbox,
//      so home-derived paths resolve INSIDE the sandbox (current + future subsystems).
//   2. Fence fs mutations under real Myco and manifest-declared agent homes.
import { afterAll } from 'bun:test';
import os from 'node:os';
import { REAL_HOME } from './sandbox-environment.js';
import { protectedAgentPaths } from './protected-agent-paths.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { removeRegisteredTestPaths } from '../support/remove-when-tests-end.js';

configureSqliteLibrary();

// The per-user lock root tests use (tests/helpers/per-user-lock-namespace.ts).
// The runner hands every test process one; a run outside the runner gets one
// made here and removed with the sandbox home. Under --isolate Bun resets
// process.env between files, so each file's preload makes and removes its own.
const LOCKS_ROOT_ENV = 'MYCO_TEST_PER_USER_LOCKS_ROOT';
const OWN_LOCKS_ROOT = process.env[LOCKS_ROOT_ENV]
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-locks-'));
if (OWN_LOCKS_ROOT !== null) process.env[LOCKS_ROOT_ENV] = OWN_LOCKS_ROOT;

// Expose the real home for the proof test (it cannot recompute it post-redirect).
(globalThis as Record<string, unknown>).__MYCO_TEST_REAL_HOME__ = REAL_HOME;

// Capture originals BEFORE wrapping (cleanup + delegation must bypass the fence).
const origRmSync = fs.rmSync.bind(fs);

// Fence mutations to the operating-system account home.
const PROTECTED = [
  ...protectedAgentPaths(REAL_HOME),
  path.join(REAL_HOME, '.myco'),
  path.join(REAL_HOME, '.myco-team'),
  path.join(REAL_HOME, '.myco-dev'),
  path.join(REAL_HOME, '.myco-collective'),
  path.join(REAL_HOME, 'myco_backups'),
];
const originalRealpath = fs.realpathSync.bind(fs);
const originalReadlink = fs.readlinkSync.bind(fs);
function resolvedTarget(target: string): string {
  let ancestor = target;
  const suffix: string[] = [];
  while (true) {
    try { return path.join(originalRealpath(ancestor), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return target;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      try {
        const link = originalReadlink(ancestor);
        return resolvedTarget(path.resolve(path.dirname(ancestor), link, ...suffix));
      } catch (linkError) {
        const linkCode = (linkError as NodeJS.ErrnoException).code;
        if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'EACCES', 'EPERM'].includes(linkCode ?? '')) throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return target;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
const protectedTargets = [...new Set(PROTECTED.flatMap((root) => [root, resolvedTarget(root)]))];
function offending(p: unknown, includesParents = false): string | null {
  let raw: string;
  if (typeof p === 'string') raw = p;
  else if (p instanceof URL) raw = fileURLToPath(p);
  else if (Buffer.isBuffer(p)) raw = p.toString();
  else return null;
  let s: string;
  try { s = path.resolve(raw); } catch { return null; }
  for (const target of [s, resolvedTarget(s)]) {
    for (const pre of protectedTargets) {
      if (target === pre || target.startsWith(pre + path.sep)
        || (includesParents && pre.startsWith(target.endsWith(path.sep) ? target : target + path.sep))) return s;
    }
  }
  return null;
}
function deny(fnName: string, hit: string): never {
  throw new Error(
    `TEST SAFETY: fs.${fnName} to live config path "${hit}" was blocked. Tests must ` +
    `not touch real home configuration. Use sandbox HOME/MYCO_HOME or explicit sandbox paths.`,
  );
}
type AnyFn = (...a: unknown[]) => unknown;
function wrap(mod: Record<string, AnyFn>, name: string, argIdxs: number[]) {
  const orig = mod[name];
  if (typeof orig !== 'function') return;
  mod[name] = function (this: unknown, ...args: unknown[]) {
    for (const i of argIdxs) { const hit = offending(args[i], /^(rename|rm|rmdir)/.test(name)); if (hit) deny(name, hit); }
    return orig.apply(this, args);
  } as AnyFn;
}
const FS = fs as unknown as Record<string, AnyFn>;
// single-path mutators → guard arg0
for (const n of ['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','chmodSync','chownSync','truncateSync','lchmodSync','lchownSync']) wrap(FS, n, [0]);
// two-path → guard the destination (and both for rename)
wrap(FS, 'copyFileSync', [1]);
wrap(FS, 'cpSync', [1]);
wrap(FS, 'symlinkSync', [1]);   // symlinkSync(target, path) — guard the link path
wrap(FS, 'linkSync', [0, 1]);
wrap(FS, 'renameSync', [0, 1]); // moving a protected path away is also a mutation
// openSync with a write/create flag → guard arg0
{
  const origOpen = FS.openSync;
  if (typeof origOpen === 'function') {
    FS.openSync = function (this: unknown, ...args: unknown[]) {
      const f = typeof args[1] === 'string' ? args[1] : '';
      const isWrite = typeof args[1] === 'number' ? true : /[wa+]/.test(f);
      if (isWrite) { const hit = offending(args[0]); if (hit) deny('openSync', hit); }
      return origOpen.apply(this, args);
    } as AnyFn;
  }
}
// createWriteStream opens for writing on call — guard arg0
wrap(FS, 'createWriteStream', [0]);
// callback-form fs writers — same path-arg indices as their sync counterparts
for (const n of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','chown','truncate']) wrap(FS, n, [0]);
wrap(FS, 'copyFile', [1]);
wrap(FS, 'cp', [1]);
wrap(FS, 'symlink', [1]);
wrap(FS, 'link', [0, 1]);
wrap(FS, 'rename', [0, 1]);
// callback-form open: guard arg0 only when flags indicate a write
{
  const origOpenCb = FS.open;
  if (typeof origOpenCb === 'function') {
    FS.open = function (this: unknown, ...args: unknown[]) {
      const f = typeof args[1] === 'string' ? args[1] : '';
      const isWrite = typeof args[1] === 'number' ? true : /[wa+]/.test(f);
      if (isWrite) { const hit = offending(args[0]); if (hit) deny('open', hit); }
      return origOpenCb.apply(this, args);
    } as AnyFn;
  }
}
// fs.promises mirror
const FSP = fs.promises as unknown as Record<string, AnyFn>;
for (const n of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','chown','truncate']) wrap(FSP, n, [0]);
wrap(FSP, 'copyFile', [1]);
wrap(FSP, 'cp', [1]);
wrap(FSP, 'symlink', [1]);
wrap(FSP, 'link', [0, 1]);
wrap(FSP, 'rename', [0, 1]);

// Promise-form open can create or truncate files too.
{
  const original = FSP.open!;
  FSP.open = function (this: unknown, ...args: unknown[]) {
    const flags = args[1];
    if (typeof flags === 'number' || (typeof flags === 'string' && /[wa+]/.test(flags))) {
      const hit = offending(args[0]);
      if (hit) deny('open', hit);
    }
    return original.apply(this, args);
  };
}

// Bun's native writer does not delegate to node:fs.
const originalBunWrite = Bun.write;
Bun.write = ((destination: Parameters<typeof Bun.write>[0], ...args: unknown[]) => {
  const target = typeof destination === 'object' && !(destination instanceof URL)
    && 'name' in destination ? destination.name : destination;
  const hit = offending(target);
  if (hit) deny('Bun.write', hit);
  return (originalBunWrite as unknown as AnyFn)(destination, ...args);
}) as typeof Bun.write;

const originalBunFile = Bun.file;
Bun.file = ((...args: Parameters<typeof Bun.file>) => {
  const file = originalBunFile(...args);
  const writer = file.writer.bind(file);
  file.writer = (...options: Parameters<typeof file.writer>) => {
    const hit = offending(file.name);
    if (hit) deny('Bun.file.writer', hit);
    return writer(...options);
  };
  return file;
}) as typeof Bun.file;

// Remove registered fixtures and process-owned locks through the captured original. Bun's test runner runs a preload's
// `afterAll` after every file's own hooks (once per file under --isolate, where this
// preload also runs once per file) and does not emit process 'exit'; the 'exit'
// listener covers any other host.
function removeSandboxHome(): void {
  removeRegisteredTestPaths(origRmSync);
  if (OWN_LOCKS_ROOT !== null) {
    try { origRmSync(OWN_LOCKS_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
afterAll(removeSandboxHome);
process.on('exit', removeSandboxHome);

// `cloudflare:workers` is a workerd builtin; the containers package imports it
// at module load, and the Worker index re-exports the harness container class.
// Bun resolves the builtin to inert stand-ins so the graph loads; anything
// exercising real Durable Object behavior runs under workerd, never here.
Bun.plugin({
  name: 'cloudflare-workers-builtin',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      exports: { DurableObject: class {}, WorkerEntrypoint: class {} },
      loader: 'object',
    }));
  },
});
