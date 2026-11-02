/** Private extraction and verified reuse of embedded native artifacts. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_NAME = '.myco-runtime';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o700;
const MODE_BITS = 0o777;
const VERSION_DIRECTORY = /^[a-f0-9]{64}$/;
const UNAVAILABLE_HOME = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR']);
const UNSUPPORTED_DIRECTORY_SYNC = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES', 'EISDIR', 'EBADF']);

class UntrustedArtifactPath extends Error {}

function owner(stat: fs.Stats, file: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new UntrustedArtifactPath(`Artifact path is foreign-owned: ${file}`);
  }
}

function statIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Only the cache leaf is admitted; user-controlled ancestors retain their existing modes and links. */
function privateLeaf(directory: string): void {
  try { fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UntrustedArtifactPath(`Artifact directory must be a real directory: ${directory}`);
  owner(stat, directory);
  if (typeof process.getuid === 'function' && (stat.mode & MODE_BITS) !== PRIVATE_DIRECTORY_MODE) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      owner(opened, directory);
      if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new UntrustedArtifactPath(`Artifact directory changed: ${directory}`);
      fs.fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
    } finally { fs.closeSync(fd); }
  }
}

function cacheRoot(): string {
  return path.join(fs.realpathSync(os.homedir()), CACHE_NAME);
}

function temporaryCache(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'myco-native-'));
}

function matches(file: string, bytes: Uint8Array): boolean {
  const stat = statIfPresent(file);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new UntrustedArtifactPath(`Artifact must be a regular file: ${file}`);
  owner(stat, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    owner(opened, file);
    if (!opened.isFile()) throw new UntrustedArtifactPath(`Artifact must be a regular file: ${file}`);
    return fs.readFileSync(fd).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } finally { fs.closeSync(fd); }
}

function busy(error: unknown): boolean {
  return ['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** One invocation's native files, cached per user or extracted into a fresh private temporary directory. */
export class NativeArtifactCache {
  private root: string | null = null;
  private location: string;

  get directory(): string { return this.location; }

  constructor(version: string) {
    try {
      this.root = cacheRoot();
      privateLeaf(this.root);
      this.location = path.join(this.root, createHash('sha256').update(version).digest('hex'));
      privateLeaf(this.directory);
    } catch (error) {
      if (!UNAVAILABLE_HOME.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      this.root = null;
      this.location = temporaryCache();
    }
  }

  /** Correct existing bytes are reused, including a concurrent publisher's completed file. */
  materialize(name: string, bytes: Uint8Array): string {
    if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Artifact name must be a filename');
    try { return this.publish(name, bytes); }
    catch (error) {
      if (this.root === null || !UNAVAILABLE_HOME.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      this.root = null;
      this.location = temporaryCache();
      return this.publish(name, bytes);
    }
  }

  private reuse(file: string, bytes: Uint8Array): boolean {
    if (!matches(file, bytes)) return false;
    if (process.platform !== 'win32' && (fs.lstatSync(file).mode & MODE_BITS) !== PRIVATE_FILE_MODE) fs.chmodSync(file, PRIVATE_FILE_MODE);
    return true;
  }

  private publish(name: string, bytes: Uint8Array): string {
    const file = path.join(this.directory, name);
    if (this.reuse(file, bytes)) return file;
    const staging = fs.mkdtempSync(path.join(this.directory, '.myco-native-'));
    const temporary = path.join(staging, name);
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: PRIVATE_FILE_MODE });
      const fd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!matches(temporary, bytes)) throw new Error(`Artifact bytes differ from embedded bytes: ${file}`);
      if (this.reuse(file, bytes)) return file;
      try { fs.renameSync(temporary, file); }
      catch (error) { if (!busy(error) || !matches(file, bytes)) throw error; }
      if (!matches(file, bytes)) throw new Error(`Published artifact bytes differ from embedded bytes: ${file}`);
      if (process.platform !== 'win32') syncDirectory(this.directory);
      this.prune();
      return file;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  private prune(): void {
    if (this.root === null) return;
    for (const entry of fs.readdirSync(this.root)) {
      const file = path.join(this.root, entry);
      if (!VERSION_DIRECTORY.test(entry) || file === this.directory) continue;
      const stat = statIfPresent(file);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) continue;
      try { fs.rmSync(file, { recursive: true, force: true }); }
      catch (error) { if (!busy(error)) throw error; }
    }
  }
}

/** Remove only this user's admitted native cache; other home contents are preserved. */
export function removeNativeArtifactCache(): void {
  let root: string;
  try { root = cacheRoot(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (statIfPresent(root) === null) return;
  privateLeaf(root);
  fs.rmSync(root, { recursive: true, force: true });
}
