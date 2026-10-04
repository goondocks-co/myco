import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedAgentPaths } from './protected-agent-paths.js';

// Fence mutations to the operating-system account home.
const scopes = new Set<string[]>();
export function installFilesystemFence(home: string, additionalRoots: string[] = []) {
  const protectedRoots = [
    ...protectedAgentPaths(home),
    ...['.myco', '.myco-team', '.myco-dev', '.myco-collective', 'myco_backups'].map((name) => path.join(home, name)),
    ...additionalRoots,
  ];
  const targets = [...new Set(protectedRoots.flatMap((root) => [root, resolvedTarget(root)]))];
  scopes.add(targets);
  return { protectedRoots, dispose: () => { scopes.delete(targets); } };
}
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

function offending(p: unknown, includesParents = false): string | null {
  let raw: string;
  if (typeof p === 'string') raw = p;
  else if (p instanceof URL) raw = fileURLToPath(p);
  else if (Buffer.isBuffer(p)) raw = p.toString();
  else return null;
  let s: string;
  try { s = path.resolve(raw); } catch { return null; }
  for (const target of [s, resolvedTarget(s)]) {
    for (const pre of [...scopes].flat()) {
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
for (const n of ['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','chmodSync','chownSync','truncateSync','lchmodSync','lchownSync','mkdtempSync','utimesSync','lutimesSync']) wrap(FS, n, [0]);
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
for (const n of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','chown','truncate','mkdtemp','utimes','lutimes','lchmod','lchown']) wrap(FS, n, [0]);
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
for (const n of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','chown','truncate','mkdtemp','utimes','lutimes','lchmod','lchown']) wrap(FSP, n, [0]);
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

function fenceBunFile(file: Bun.BunFile): Bun.BunFile {
  const methods = file as unknown as Record<string, AnyFn>;
  for (const name of ['writer', 'write', 'delete', 'unlink']) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    methods[name] = (...options: unknown[]) => {
      const hit = offending(file.name);
      if (hit) deny(`Bun.file.${name}`, hit);
      return original.apply(file, options);
    };
  }
  const slice = methods.slice!;
  methods.slice = (...options: unknown[]) => fenceBunFile(slice.apply(file, options) as Bun.BunFile);
  return file;
}
const originalBunFile = Bun.file;
Bun.file = ((...args: Parameters<typeof Bun.file>) => fenceBunFile(originalBunFile(...args))) as typeof Bun.file;
