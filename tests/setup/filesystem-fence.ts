import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedAgentPaths } from './protected-agent-paths.js';
import { systemTempDirectories } from '../../scripts/test-temp-root.mjs';

// Fence mutations to the operating-system account home.
// The in-process fence does not cover already-existing hard-link aliases
// outside protected roots or filesystem mutations by child processes.
const scopes = new Set<string[]>();
const tempScopes = new Set<{ root: string; directories: string[] }>();
const TEST_TEMP_NAME = /^(?:myco-|mt-)/;
export function installTestTempFence(root: string, directories: string[] = process.env.MYCO_TEST_SYSTEM_TEMP_DIRS
  ? JSON.parse(process.env.MYCO_TEST_SYSTEM_TEMP_DIRS) as string[] : systemTempDirectories()) {
  const scope = { root: resolvedTarget(path.resolve(root)), directories: directories.map((dir) => resolvedTarget(path.resolve(dir))) };
  tempScopes.add(scope);
  return { dispose: () => { tempScopes.delete(scope); } };
}
export function installFilesystemFence(home: string, additionalRoots: string[] = []) {
  const protectedRoots = [
    ...protectedAgentPaths(home),
    ...['.myco', '.myco-team', '.myco-dev', '.myco-collective', 'myco_backups'].map((name) => path.join(home, name)),
    ...additionalRoots,
  ];
  const targets = [...new Set(protectedRoots.flatMap((root) => {
    const literal = path.resolve(root);
    return [literal, resolvedTarget(literal, true)];
  }))];
  scopes.add(targets);
  return { protectedRoots, dispose: () => { scopes.delete(targets); } };
}
const originalRealpath = fs.realpathSync.bind(fs);
const originalReadlink = fs.readlinkSync.bind(fs);
const originalExists = fs.existsSync.bind(fs);
const originalFstat = fs.fstatSync.bind(fs);
const originalLstat = fs.lstatSync.bind(fs);
const METADATA_LOOKUP_ATTEMPTS = 3;
function retryInterrupted<T>(lookup: () => T): T {
  for (let attempt = 1; ; attempt += 1) {
    try { return lookup(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EINTR' || attempt >= METADATA_LOOKUP_ATTEMPTS) throw error;
    }
  }
}
function resolvedTarget(target: string, protectUnreadableRoot = false): string {
  let ancestor = target;
  const suffix: string[] = [];
  while (true) {
    try { return path.join(retryInterrupted(() => originalRealpath(ancestor)), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const unreadable = protectUnreadableRoot && (code === 'EPERM' || code === 'EACCES');
      if (!unreadable && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      let link: string | undefined;
      if (!unreadable) {
        try {
          link = retryInterrupted(() => originalReadlink(ancestor));
        } catch (linkError) {
          const linkCode = (linkError as NodeJS.ErrnoException).code;
          if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(linkCode ?? '')) throw linkError;
        }
      }
      if (link !== undefined) return resolvedTarget(path.resolve(path.dirname(ancestor), link, ...suffix), protectUnreadableRoot);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        if (unreadable) return target;
        throw error;
      }
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

type FenceHit = { path: string; boundary: 'home' | 'temp' };
const descriptorPaths = new Map<number, string[]>();
function descriptorTargets(target: unknown): string[] {
  if (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target)) {
    const absolute = path.resolve(target instanceof URL ? fileURLToPath(target) : target.toString());
    return [absolute, resolvedTarget(absolute)];
  }
  return [];
}
function within(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function offending(p: unknown, includesParents = false): FenceHit | null {
  const fd = typeof p === 'number' ? p
    : p !== null && typeof p === 'object' && 'fd' in p && typeof p.fd === 'number' ? p.fd : undefined;
  if (fd !== undefined) {
    const targets = descriptorPaths.get(fd);
    if (!targets) throw new Error(`TEST SAFETY: mutation through untracked file descriptor ${fd} was blocked. Open files through fenced fs.`);
    for (const target of targets) {
      const hit = offending(target, includesParents);
      if (hit) return hit;
    }
    return null;
  }
  let raw: string;
  if (typeof p === 'string') raw = p;
  else if (p instanceof URL) raw = fileURLToPath(p);
  else if (Buffer.isBuffer(p)) raw = p.toString();
  else return null;
  let s: string;
  try { s = path.resolve(raw); } catch { return null; }
  return offendingPaths([s], includesParents) ?? offendingPaths([s, resolvedTarget(s)], includesParents);
}
function offendingPaths(targets: string[], includesParents: boolean): FenceHit | null {
  for (const target of targets) {
    for (const pre of [...scopes].flat()) {
      if (target === pre || target.startsWith(pre + path.sep)
        || (includesParents && pre.startsWith(target.endsWith(path.sep) ? target : target + path.sep))) return { path: targets[0]!, boundary: 'home' };
    }
    for (const scope of tempScopes) {
      if (within(target, scope.root)) continue;
      for (const dir of scope.directories) {
        if (!within(target, dir)) continue;
        const names = path.relative(dir, target).split(path.sep);
        for (const [index, name] of names.entries()) {
          if (TEST_TEMP_NAME.test(name) && (index === names.length - 1
            || !originalExists(path.join(dir, ...names.slice(0, index + 1))))) {
            return { path: targets[0]!, boundary: 'temp' };
          }
        }
      }
    }
  }
  return null;
}
// Unreadable fixture leaves resolve through a readable parent and non-symlink metadata.
export function assertUnfencedFixtureMutationAllowed(target: string): string {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) {
    throw new Error('TEST SAFETY: permission fixtures require a normalized absolute path');
  }
  for (let ancestor = target; ; ancestor = path.dirname(ancestor)) {
    if (retryInterrupted(() => originalLstat(ancestor)).isSymbolicLink()) {
      throw new Error('TEST SAFETY: permission fixtures must not traverse a symbolic link');
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const canonical = path.join(retryInterrupted(() => originalRealpath(path.dirname(target))), path.basename(target));
  const hit = offendingPaths([target, canonical], true);
  if (hit) deny('permissionFixture', hit);
  const stat = retryInterrupted(() => originalLstat(target));
  if (stat.nlink > 1 && !stat.isDirectory()) {
    throw new Error('TEST SAFETY: permission fixtures must not mutate a hard-linked file');
  }
  return canonical;
}
function deny(fnName: string, hit: FenceHit): never {
  throw new Error(
    hit.boundary === 'temp'
      ? `TEST SAFETY: fs.${fnName} to temp path "${hit.path}" outside the run root was blocked. Use the test run's TMPDIR.`
      : `TEST SAFETY: fs.${fnName} to live config path "${hit.path}" was blocked. Tests must `
        + `not touch real home configuration. Use sandbox HOME/MYCO_HOME or explicit sandbox paths.`,
  );
}
type AnyFn = (...a: unknown[]) => unknown;
function anonymousOutputStream(name: string, fd: unknown): boolean {
  if ((fd !== 1 && fd !== 2) || descriptorPaths.has(fd) || !/^(write|writeSync|writev|writevSync)$/.test(name)) return false;
  const stat = retryInterrupted(() => originalFstat(fd));
  if (!stat.isFIFO() && !stat.isSocket()) return false;
  if (process.platform === 'linux') return /^(?:pipe|socket):\[\d+\]$/.test(retryInterrupted(() => originalReadlink(`/proc/self/fd/${fd}`)));
  return stat.nlink === 0 || process.platform === 'win32';
}
function wrap(mod: Record<string, AnyFn>, name: string, argIdxs: number[]) {
  const orig = mod[name];
  if (typeof orig !== 'function') return;
  mod[name] = function (this: unknown, ...args: unknown[]) {
    for (const i of argIdxs) {
      if (anonymousOutputStream(name, args[i])) continue;
      const hit = offending(args[i], /^(rename|rm|rmdir|cp$|cpSync$)/.test(name));
      if (hit) deny(name, hit);
    }
    return orig.apply(this, args);
  } as AnyFn;
}
const FS = fs as unknown as Record<string, AnyFn>;
function writableFlags(flags: unknown): boolean {
  return typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
    : typeof flags === 'string' && /[wa+]/.test(flags);
}
function guardOpen(name: string, target: unknown, flags: unknown): void {
  if (!writableFlags(flags)) return;
  const hit = offending(target);
  if (hit) deny(name, hit);
}
// single-path mutators → guard arg0
for (const n of ['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','chmodSync','chownSync','truncateSync','lchmodSync','lchownSync','mkdtempSync','utimesSync','lutimesSync']) wrap(FS, n, [0]);
for (const n of ['writeSync', 'writevSync', 'fchmodSync', 'fchownSync', 'ftruncateSync', 'futimesSync']) wrap(FS, n, [0]);
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
      guardOpen('openSync', args[0], args[1]);
      const targets = descriptorTargets(args[0]);
      const fd = origOpen.apply(this, args) as number;
      descriptorPaths.set(fd, targets);
      return fd;
    } as AnyFn;
  }
}
// Stream descriptors retain their opening targets.
function trackStream<T extends fs.ReadStream | fs.WriteStream>(stream: T, targets: string[], customOpen: boolean): T {
  stream.on('open', (fd: number) => {
    if (!customOpen && !descriptorPaths.has(fd)) descriptorPaths.set(fd, targets);
  });
  return stream;
}
{
  const original = fs.createReadStream;
  fs.createReadStream = ((target, options) => {
    const targets = descriptorTargets(target);
    return trackStream(original(target, options), targets, typeof options === 'object' && options?.fs !== undefined);
  }) as typeof fs.createReadStream;
}
{
  const original = fs.createWriteStream;
  fs.createWriteStream = ((target, options) => {
    const fd = typeof options === 'object' ? options?.fd : undefined;
    const hit = offending(target) ?? (anonymousOutputStream('write', fd) ? null : offending(fd));
    if (hit) deny('createWriteStream', hit);
    const targets = descriptorTargets(target);
    return trackStream(original(target, options), targets, typeof options === 'object' && options?.fs !== undefined);
  }) as typeof fs.createWriteStream;
}
// callback-form fs writers — same path-arg indices as their sync counterparts
for (const n of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','chown','truncate','mkdtemp','utimes','lutimes','lchmod','lchown']) wrap(FS, n, [0]);
for (const n of ['write', 'writev', 'fchmod', 'fchown', 'ftruncate', 'futimes']) wrap(FS, n, [0]);
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
      guardOpen('open', args[0], args[1]);
      const targets = descriptorTargets(args[0]);
      const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void;
      if (typeof callback !== 'function') return origOpenCb.apply(this, args);
      args[args.length - 1] = (error: NodeJS.ErrnoException | null, fd: number) => {
        if (!error) descriptorPaths.set(fd, targets);
        callback(error, fd);
      };
      return origOpenCb.apply(this, args);
    } as AnyFn;
  }
}
{
  const original = fs.closeSync;
  fs.closeSync = (fd) => { original(fd); descriptorPaths.delete(fd); };
  const originalCallback = FS.close!;
  FS.close = function (this: unknown, ...args: unknown[]) {
    const fd = args[0] as number;
    const callback = args[1] as ((error: NodeJS.ErrnoException | null) => void) | undefined;
    if (typeof callback !== 'function') return originalCallback.apply(this, args);
    args[1] = (error: NodeJS.ErrnoException | null) => {
      if (!error) descriptorPaths.delete(fd);
      callback(error);
    };
    return originalCallback.apply(this, args);
  };
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
    guardOpen('open', args[0], args[1]);
    const targets = descriptorTargets(args[0]);
    return (original.apply(this, args) as Promise<FileHandle>).then((handle) => {
      descriptorPaths.set(handle.fd, targets);
      const methods = handle as unknown as Record<string, AnyFn>;
      for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) {
        const mutate = methods[name];
        if (typeof mutate !== 'function') continue;
        methods[name] = (...options) => {
          const hit = offending(handle.fd);
          if (hit) deny(`FileHandle.${name}`, hit);
          return mutate.apply(handle, options);
        };
      }
      const close = handle.close.bind(handle);
      handle.close = async () => {
        const fd = handle.fd;
        await close();
        descriptorPaths.delete(fd);
      };
      return handle;
    });
  };
}

// Bun's native writer does not delegate to node:fs.
const bunFileTargets = new WeakMap<Bun.BunFile, unknown>();
const originalBunWrite = Bun.write;
Bun.write = ((destination: Parameters<typeof Bun.write>[0], ...args: unknown[]) => {
  const target = typeof destination === 'object' && !(destination instanceof URL)
    && 'name' in destination ? bunFileTargets.get(destination as unknown as Bun.BunFile) ?? destination.name : destination;
  const hit = anonymousOutputStream('write', target) ? null : offending(target);
  if (hit) deny('Bun.write', hit);
  return (originalBunWrite as unknown as AnyFn)(destination, ...args);
}) as typeof Bun.write;

function fenceBunFile(file: Bun.BunFile, destination: unknown = file.name): Bun.BunFile {
  bunFileTargets.set(file, destination);
  const methods = file as unknown as Record<string, AnyFn>;
  for (const name of ['writer', 'write', 'delete', 'unlink']) {
    const original = methods[name];
    if (typeof original !== 'function') continue;
    methods[name] = (...options: unknown[]) => {
      const hit = (name === 'writer' || name === 'write') && anonymousOutputStream('write', destination) ? null : offending(destination);
      if (hit) deny(`Bun.file.${name}`, hit);
      return original.apply(file, options);
    };
  }
  const slice = methods.slice!;
  methods.slice = (...options: unknown[]) => fenceBunFile(slice.apply(file, options) as Bun.BunFile, destination);
  return file;
}
const originalBunFile = Bun.file;
Bun.file = ((...args: Parameters<typeof Bun.file>) => fenceBunFile(originalBunFile(...args), args[0])) as typeof Bun.file;
