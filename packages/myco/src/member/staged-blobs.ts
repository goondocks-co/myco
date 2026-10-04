import crypto from 'node:crypto';
import fs from 'node:fs';
import type { BlobSource } from './envelope.js';
import { MEMBER_FILE_MODE } from './constants.js';
import { pathIsAbsent, renameReplacing } from './store.js';

export type StagedBlobRead = { status: 'ready'; bytes: Buffer } | { status: 'missing' | 'unreadable' | 'corrupt' };

/** Read and verify local payloads before either migration or delivery consumes their records. */
export function readStagedBlob(source: BlobSource): StagedBlobRead {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(source.path); }
  catch { return { status: pathIsAbsent(source.path) ? 'missing' : 'unreadable' }; }
  if (bytes.byteLength !== source.size || crypto.createHash('sha256').update(bytes).digest('hex') !== source.sha256) return { status: 'corrupt' };
  return { status: 'ready', bytes };
}

/** Publish complete verified bytes by rename; concurrent identical stagers publish interchangeable objects. */
export function publishStagedBlob(source: BlobSource, bytes: Uint8Array): void {
  if (readStagedBlob(source).status === 'ready') {
    const now = new Date();
    try { fs.utimesSync(source.path, now, now); return; }
    catch (err) { if (!pathIsAbsent(source.path)) throw err; }
  }
  const temporary = `${source.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: MEMBER_FILE_MODE, flag: 'wx' });
    const staged = readStagedBlob({ ...source, path: temporary });
    if (staged.status !== 'ready') throw new Error(`Staged blob publication failed verification (${staged.status})`);
    renameReplacing(temporary, source.path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
