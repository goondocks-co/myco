import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncDirectoryForDurability } from '../utils/sync-directory.js';
import type { BlobSource } from './envelope.js';
import { MEMBER_FILE_MODE } from './constants.js';
import { pathIsAbsent, renameReplacing } from './store.js';

export type StagedBlobRead = { status: 'ready'; bytes: Buffer } | { status: 'missing' | 'unreadable' | 'corrupt' };

const UNSUPPORTED_DIRECTORY_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);

function syncDirectoryIfSupported(directory: string): void {
  try { syncDirectoryForDurability(directory); }
  catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

/** Read and verify local payloads before either migration or delivery consumes their records. */
function readOne(source: BlobSource): StagedBlobRead {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(source.path); }
  catch { return { status: pathIsAbsent(source.path) ? 'missing' : 'unreadable' }; }
  if (bytes.byteLength !== source.size || crypto.createHash('sha256').update(bytes).digest('hex') !== source.sha256) return { status: 'corrupt' };
  return { status: 'ready', bytes };
}

/** Retained migration staging carries the same missing, corrupt and transient availability contract. */
export function readStagedBlob(source: BlobSource): StagedBlobRead {
  const primary = readOne(source);
  if (primary.status === 'ready' || source.migrationSource === undefined) return primary;
  const retained = readOne({ ...source, path: source.migrationSource.path });
  if (retained.status === 'ready') return retained;
  const retired = readOne({ ...source, path: source.migrationSource.retiredPath });
  if (retired.status === 'ready') return retired;
  const outcomes = [primary, retained, retired];
  if (outcomes.some((read) => read.status === 'unreadable')) return { status: 'unreadable' };
  if (outcomes.some((read) => read.status === 'corrupt')) return { status: 'corrupt' };
  return { status: 'missing' };
}

/** Publish complete verified bytes by rename; concurrent identical stagers publish interchangeable objects. */
export function publishStagedBlob(source: BlobSource, bytes: Uint8Array): void {
  if (readOne(source).status === 'ready') {
    const now = new Date();
    try { fs.utimesSync(source.path, now, now); return; }
    catch (err) { if (!pathIsAbsent(source.path)) throw err; }
  }
  const temporary = `${source.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: MEMBER_FILE_MODE, flag: 'wx' });
    const staged = readOne({ ...source, path: temporary });
    if (staged.status !== 'ready') throw new Error(`Staged blob publication failed verification (${staged.status})`);
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const directory = path.dirname(source.path);
    syncDirectoryIfSupported(directory);
    renameReplacing(temporary, source.path);
    syncDirectoryIfSupported(directory);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
