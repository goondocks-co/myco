// TEST-ONLY safety net. Loaded via bunfig [test] preload for EVERY bun test run
// (root bunfig.toml: node phases + raw `bun test`/`--watch`; bunfig.dom.toml:
// jsdom phase). Two chokepoints make a test touching live config improbable and,
// if something slips, loud:
//   1. Redirect os.homedir()/userInfo()/HOME to a throwaway per-process sandbox,
//      so home-derived paths resolve INSIDE the sandbox (current + future subsystems).
//   2. Fence fs mutations whose resolved target is under the REAL ~/.myco* — throw.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const REAL_HOME = os.homedir();
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-home-'));

// Expose the real home for the proof test (it cannot recompute it post-redirect).
(globalThis as Record<string, unknown>).__MYCO_TEST_REAL_HOME__ = REAL_HOME;

// Capture originals BEFORE wrapping (cleanup + delegation must bypass the fence).
const origRmSync = fs.rmSync.bind(fs);

// ---- Chokepoint 2 first (so REAL_HOME, captured above, is the guard) ----
const PROTECTED = [
  path.join(REAL_HOME, '.myco'),
  path.join(REAL_HOME, '.myco-team'),
  path.join(REAL_HOME, '.myco-dev'),
  path.join(REAL_HOME, '.myco-collective'),
  path.join(REAL_HOME, 'myco_backups'),
];
function offending(p: unknown): string | null {
  let raw: string;
  if (typeof p === 'string') raw = p;
  else if (p instanceof URL) raw = p.pathname;
  else if (Buffer.isBuffer(p)) raw = p.toString();
  else return null;
  let s: string;
  try { s = path.resolve(raw); } catch { return null; }
  for (const pre of PROTECTED) if (s === pre || s.startsWith(pre + path.sep)) return s;
  return null;
}
function deny(fnName: string, hit: string): never {
  throw new Error(
    `TEST SAFETY: fs.${fnName} to live config path "${hit}" was blocked. Tests must ` +
    `not touch the real ~/.myco*. Use a temp MYCO_HOME/MYCO_TEAM_HOME or explicit sandbox paths.`,
  );
}
type AnyFn = (...a: unknown[]) => unknown;
function wrap(mod: Record<string, AnyFn>, name: string, argIdxs: number[]) {
  const orig = mod[name];
  if (typeof orig !== 'function') return;
  mod[name] = function (this: unknown, ...args: unknown[]) {
    for (const i of argIdxs) { const hit = offending(args[i]); if (hit) deny(name, hit); }
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
wrap(FS, 'linkSync', [1]);
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
wrap(FS, 'link', [1]);
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
wrap(FSP, 'link', [1]);
wrap(FSP, 'rename', [0, 1]);

// ---- Chokepoint 1: redirect the home (after the fence is installed) ----
function setHomedir(v: () => string) {
  try { (os as { homedir: () => string }).homedir = v; }
  catch { Object.defineProperty(os, 'homedir', { value: v, configurable: true }); }
}
setHomedir(() => SANDBOX_HOME);
const origUserInfo = os.userInfo.bind(os);
try {
  (os as { userInfo: typeof os.userInfo }).userInfo = ((opts?: unknown) => ({
    ...(origUserInfo as (o?: unknown) => Record<string, unknown>)(opts),
    homedir: SANDBOX_HOME,
  })) as typeof os.userInfo;
} catch { /* best-effort */ }
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

// Clean the throwaway sandbox on process exit (bypass the fence via the captured orig).
process.on('exit', () => { try { origRmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
