import fs from 'node:fs';
import crypto from 'node:crypto';
import { REFUSAL_RETRY_INITIAL_MS, REFUSAL_RETRY_MAX_MS } from './constants.js';
import type { BlobSource } from './envelope.js';
import { readStagedBlob, type StagedBlobRead } from './staged-blobs.js';

/** Missing bytes require two independent observations at least this far apart. */
export const MISSING_PAYLOAD_CONFIRM_MS = 30_000;
export interface PayloadRetry {
  reason: 'missing' | 'unreadable' | 'corrupt';
  since: number;
  checks: number;
  at: number;
  backoffMs: number;
}
export type PayloadDisposition = { status: 'ready'; bytes: Buffer }
  | { status: 'retry'; retry: PayloadRetry } | { status: 'missing' };

/** Verify source bytes before repair; an unrelated rewrite cannot satisfy the captured digest. */
function recoveryBytes(source: BlobSource): Buffer | null {
  if (source.recovery === undefined) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(source.recovery.path, 'r');
    const bytes = Buffer.alloc(source.size);
    const length = fs.readSync(fd, bytes, 0, source.size, source.recovery.offset ?? 0);
    return length === source.size && crypto.createHash('sha256').update(bytes).digest('hex') === source.sha256 ? bytes : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Shared local availability policy: verified repair, transient backoff, then explicit confirmed loss. */
export function payloadDisposition(source: BlobSource, previous: PayloadRetry | undefined, now: number, repair: (bytes: Buffer) => void): PayloadDisposition {
  let read: StagedBlobRead = readStagedBlob(source);
  if (read.status !== 'ready' && previous?.reason === read.status && previous.at > now) return { status: 'retry', retry: previous };
  if (read.status !== 'ready') {
    const bytes = recoveryBytes(source);
    if (bytes !== null) {
      try { repair(bytes); read = readStagedBlob(source); }
      catch {
        process.stderr.write('[myco] member: staged payload repair failed — retained for retry\n');
        read = { status: 'unreadable' };
      }
    }
  }
  if (read.status === 'ready') return read;
  const same = previous?.reason === read.status;
  const since = same ? previous.since : now;
  const checks = same ? previous.checks + 1 : 1;
  if ((read.status === 'missing' || read.status === 'corrupt') && checks >= 2 && now - since >= MISSING_PAYLOAD_CONFIRM_MS) return { status: 'missing' };
  const initial = read.status === 'unreadable' ? REFUSAL_RETRY_INITIAL_MS : MISSING_PAYLOAD_CONFIRM_MS;
  const backoffMs = same ? Math.min(previous.backoffMs * 2, REFUSAL_RETRY_MAX_MS) : initial;
  return { status: 'retry', retry: { reason: read.status, since, checks, at: now + backoffMs, backoffMs } };
}
