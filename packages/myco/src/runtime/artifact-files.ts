/** Private, verified publication of native libraries and executable artifacts. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o700;
const NON_OWNER_WRITE = 0o022;
const NON_OWNER_ACCESS = 0o077;
const STICKY_DIRECTORY = 0o1000;
const HASH_CHUNK_BYTES = 64 * 1024;
const FILE_MODE_BITS = 0o777;

function owned(stat: fs.Stats, file: string, ancestor = false): void {
  if (typeof process.getuid !== 'function') return;
  if (stat.uid !== process.getuid() && !(ancestor && stat.uid === 0)) {
    throw new Error(`Artifact path is foreign-owned: ${file}`);
  }
  if ((stat.mode & NON_OWNER_WRITE) !== 0 && !(ancestor && stat.isDirectory() && (stat.mode & STICKY_DIRECTORY) !== 0)) {
    throw new Error(`Artifact path is writable by another user: ${file}`);
  }
}

function statIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Admit each ancestor before creating a directory; the artifact directory must belong to this user. */
function artifactDirectory(directory: string, privateDirectory = false, ancestor = false): void {
  const parent = path.dirname(directory);
  if (parent !== directory) artifactDirectory(parent, false, true);
  let stat = statIfPresent(directory);
  if (stat === null) {
    try { fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Artifact directory must be a real directory: ${directory}`);
  owned(stat, directory, ancestor);
  if (privateDirectory && typeof process.getuid === 'function' && (stat.mode & NON_OWNER_ACCESS) !== 0) {
    throw new Error(`Artifact directory must be private: ${directory}`);
  }
}

function artifactFile(file: string): fs.Stats | null {
  const stat = statIfPresent(file);
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Artifact must be a regular file: ${file}`);
  owned(stat, file);
  return stat;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileDigest(file: string): string {
  if (artifactFile(file) === null) throw new Error(`Artifact is missing: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    owned(fs.fstatSync(fd), file);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    let length: number;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** The cache is rooted in the trusted user home, independent of shared temporary storage. */
export function nativeArtifactDirectory(version: string): string {
  const root = path.join(fs.realpathSync(os.homedir()), '.myco-runtime');
  artifactDirectory(root, true);
  const directory = path.join(root, digest(Buffer.from(version)));
  artifactDirectory(directory, true);
  return directory;
}

/**
 * Publish a complete artifact by rename from exclusive private staging. Source bytes are checked before any
 * preparation can load or execute them. Preparation may sign the staged executable; its resulting bytes are
 * checked again after publication.
 */
export function publishArtifact(
  destination: string,
  source: string | Uint8Array,
  options: { mode?: number; move?: boolean; prepare?: (file: string) => void } = {},
): void {
  destination = path.resolve(destination);
  if (typeof source === 'string') source = path.resolve(source);
  const directory = path.dirname(destination);
  artifactDirectory(directory);
  artifactFile(destination);
  const expected = typeof source === 'string' ? fileDigest(source) : digest(source);
  const staging = fs.mkdtempSync(path.join(directory, '.myco-place-'));
  const temporary = path.join(staging, path.basename(destination));
  try {
    artifactDirectory(staging, true);
    if (typeof source === 'string') {
      if (options.move) fs.renameSync(source, temporary);
      else fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    } else fs.writeFileSync(temporary, source, { flag: 'wx', mode: EXECUTABLE_MODE });
    fs.chmodSync(temporary, options.mode ?? EXECUTABLE_MODE);
    if (fileDigest(temporary) !== expected) throw new Error(`Artifact bytes differ from source: ${destination}`);
    options.prepare?.(temporary);
    const prepared = fileDigest(temporary);
    const fd = fs.openSync(temporary, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    artifactFile(destination);
    fs.renameSync(temporary, destination);
    if (fileDigest(destination) !== prepared) throw new Error(`Published artifact bytes differ: ${destination}`);
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

/** Reuse only verified bytes; an incomplete or differing owned file is atomically replaced. */
export function materializeArtifact(directory: string, name: string, bytes: Uint8Array, mode = EXECUTABLE_MODE): string {
  if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Artifact name must be a filename');
  directory = path.resolve(directory);
  artifactDirectory(directory, true);
  const file = path.join(directory, name);
  const stat = artifactFile(file);
  if (stat === null || fileDigest(file) !== digest(bytes) || (process.platform !== 'win32' && (stat.mode & FILE_MODE_BITS) !== mode)) {
    publishArtifact(file, bytes, { mode });
  }
  return file;
}
