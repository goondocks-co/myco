/**
 * The member spool: a write-ahead `EventBuffer` per session under
 * `<MYCO_HOME>/member/spool/<projectId>/`, one drain implementation with a
 * per-session lease and a high-water mark, the per-project offline latch, and
 * the refusal diagnostic log.
 *
 * A hook appends its envelope(s) first and drains second; the live send is the
 * drain's first iteration, so a hook the harness kills leaves a durable copy.
 * Spool records are the wire envelope plus member-private sidecars
 * (`_memberProtocol`, `_blobSource`) that never reach the wire; blob bytes are
 * never spooled — the drain re-reads them from the staged source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventBuffer, listBufferSessionIds } from '../capture/buffer.js';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { canStartRequest, clippedRequestBudget, longestDeclaredHookTimeoutMs, type HookBudget } from './budget.js';
import {
  MEMBER_FILE_MODE, MEMBER_PROTOCOL, OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS, REFUSED_LOG_MAX_BYTES, type MemberCode,
} from './constants.js';
import type { BlobSource, BlobStager, MemberEnvelope, OutboundEvent } from './envelope.js';
import { bufferLockPath, readSessionState, readSessionStateUnlocked, updateSessionState, writeSessionStateUnlocked, type SessionState } from './session-state.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';
import type { ClientRecord, Outcome, ServerClient } from './transport.js';

export const SPOOL_DIRNAME = 'spool';
export const BLOBS_DIRNAME = 'blobs';
export const OFFLINE_LATCH_FILE = 'offline.json';
export const REFUSED_LOG_FILE = 'refused.jsonl';
const DRAIN_LEASE_SUFFIX = '.drain.lock';

/** The seven envelope fields; nothing else leaves the spool. */
export const WIRE_FIELDS = ['eventId', 'sessionId', 'kind', 'createdAt', 'channel', 'producer', 'payload'] as const;

/** A spool line: the envelope plus the member-private sidecars. */
export interface SpoolRecord extends MemberEnvelope {
  _memberProtocol: number;
  _blobSource?: BlobSource;
}

export interface OfflineLatch {
  since: number;
  nextProbeAt: number;
  backoffMs: number;
}

export interface RefusedEntry {
  eventId: string;
  sessionId: string;
  kind: string;
  code: MemberCode;
  reason: string;
  at: number;
}

export type DrainEnd = Outcome['class'] | 'budget' | 'protocol_mismatch' | 'drained';

export interface DrainResult {
  sessionId: string;
  skipped?: 'lease' | 'latched' | 'never-drains';
  sent: number;
  acked: number;
  refused: number;
  /** Records still un-acknowledged after the pass. */
  remaining: number;
  endedBy: DrainEnd;
}

export interface DrainOptions {
  /** Dial even while the offline latch is set (Stop/SessionEnd probe; `myco member drain`). */
  force?: boolean;
  now?: () => number;
  /** Called once per pass on a 401 without the protocol header; a new client record retries the record once. */
  onUnauthorized?: () => Promise<ClientRecord | null>;
  /** Builds a client from a record; used after `onUnauthorized` supplies a new one. */
  clientFor?: (record: ClientRecord) => ServerClient;
}

export function spoolDirFor(projectId: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), SPOOL_DIRNAME, projectId);
}

/** The wire envelope of a spool record: the seven fields, nothing member-private, no buffer timestamp. */
export function toWire(record: SpoolRecord): MemberEnvelope {
  const out: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) out[field] = record[field];
  return out as unknown as MemberEnvelope;
}

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

export class MemberSpool {
  readonly dir: string;
  readonly blobsDir: string;
  private readonly mycoHome: string;

  constructor(readonly projectId: string, opts: { mycoHome?: string } = {}) {
    this.mycoHome = opts.mycoHome ?? resolveMycoHome();
    this.dir = spoolDirFor(projectId, this.mycoHome);
    this.blobsDir = path.join(this.dir, BLOBS_DIRNAME);
    ensureMemberDir(this.dir, this.mycoHome);
    ensureMemberDir(this.blobsDir, this.mycoHome);
  }

  /** The blob staging dir of one session: staged bytes belong to the session that staged them. */
  blobsDirFor(sessionId: string): string {
    return path.join(this.blobsDir, sessionId);
  }

  /**
   * A stager for one session: bytes land in `blobs/<sessionId>/<sha256>`
   * (0600) for the drain to upload. Staging is per session, not per project,
   * so the drain can delete a record's bytes the moment the record is
   * acknowledged — with one project-wide dir, two sessions staging identical
   * bytes would share a file and the first drain would delete it under the
   * second, whose upload would then answer `blob_absent`.
   */
  stagerFor(sessionId: string): BlobStager {
    const dir = this.blobsDirFor(sessionId);
    return (bytes, mediaType) => {
      ensureMemberDir(dir, this.mycoHome);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const file = path.join(dir, sha256);
      if (fs.existsSync(file)) {
        // Content-addressed, so the bytes are already right — but the mtime is
        // what says "a hook may still name this", and reclaiming reads it. A
        // second staging of the same sha restarts that clock, or the grace
        // could expire while the hook that just staged it is still running.
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch { /* vanished under us; the write below is not worth racing */ }
      } else {
        fs.writeFileSync(file, bytes, { mode: MEMBER_FILE_MODE });
      }
      return { path: file, sha256, mediaType, size: bytes.byteLength };
    };
  }

  private spoolFile(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  private leasePath(sessionId: string): string {
    return path.join(this.dir, `.${sessionId}${DRAIN_LEASE_SUFFIX}`);
  }

  /** The session's buffer with its lock companion and file pre-created 0600. */
  private buffer(sessionId: string): EventBuffer {
    ensurePrivateFile(bufferLockPath(this.dir, sessionId));
    ensurePrivateFile(this.spoolFile(sessionId));
    return new EventBuffer(this.dir, sessionId);
  }

  /** Write-ahead: append one record before anything is sent. */
  append(sessionId: string, out: OutboundEvent): void {
    this.appendAndRecord(sessionId, [out]);
  }

  /**
   * The commit point. The events and the state that records them having been
   * captured land together, under ONE hold of the session's buffer lock.
   *
   * A handler that derives an event also writes its receipt — the prompt hash,
   * the plan hash, the attachment key, the transcript's parsed size — and
   * nothing re-derives an event whose receipt is already on disk. Writing the
   * receipt before the append therefore makes a crash between the two a
   * permanent loss, not a retry: the rerun reads the receipt, derives nothing,
   * and the event exists nowhere. Appending first and recording in the same
   * locked section makes the durable copy the thing that cannot be missing.
   */
  appendAndRecord(sessionId: string, events: readonly OutboundEvent[], record?: (state: SessionState) => void, now: number = Date.now()): void {
    if (events.length === 0 && !record) return;
    const lock = bufferLockPath(this.dir, sessionId);
    const file = this.spoolFile(sessionId);
    ensurePrivateFile(lock);
    ensurePrivateFile(file);
    withFileLockSync(lock, () => {
      for (const out of events) {
        const line: SpoolRecord & { timestamp: string } = {
          ...out.envelope,
          _memberProtocol: MEMBER_PROTOCOL,
          ...(out.blobSource ? { _blobSource: out.blobSource } : {}),
          timestamp: new Date(now).toISOString(),
        };
        fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: MEMBER_FILE_MODE });
      }
      const state = readSessionStateUnlocked(this.dir, sessionId);
      if (state.startedAt === undefined) state.startedAt = now;
      record?.(state);
      writeSessionStateUnlocked(this.dir, sessionId, state, now);
    });
  }

  /** Session ids with a spool file. */
  sessionIds(): string[] {
    return listBufferSessionIds(this.dir).filter((id) => id !== path.basename(REFUSED_LOG_FILE, '.jsonl'));
  }

  /** Every record of the session's spool, read under the append lock; a torn line reads as null. */
  readRecords(sessionId: string): Array<SpoolRecord | null> {
    const file = this.spoolFile(sessionId);
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch {
        return [];
      }
      const out: Array<SpoolRecord | null> = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as SpoolRecord);
        } catch {
          out.push(null);
        }
      }
      return out;
    });
  }

  /** Un-acknowledged records in the session's spool. */
  depth(sessionId: string): number {
    const records = this.readRecords(sessionId);
    const state = readSessionState(this.dir, sessionId);
    return Math.max(0, records.length - state.highWater);
  }

  // ---------------------------------------------------------------------------
  // Offline latch
  // ---------------------------------------------------------------------------

  private latchPath(): string {
    return path.join(this.dir, OFFLINE_LATCH_FILE);
  }

  readLatch(): OfflineLatch | null {
    const read = readPrivateJson<OfflineLatch>(this.latchPath());
    if (!read.ok) {
      if (read.reason !== 'missing') reportSkippedPrivateFile('offline latch', this.latchPath(), read);
      return null;
    }
    const l = read.value;
    return typeof l.since === 'number' && typeof l.nextProbeAt === 'number' && typeof l.backoffMs === 'number' ? l : null;
  }

  /** True when a hook may dial: no latch, the probe time has come, or the caller forces a probe. */
  shouldDial(now: number, force = false): boolean {
    if (force) return true;
    const latch = this.readLatch();
    return latch === null || now >= latch.nextProbeAt;
  }

  /** Set or extend the latch: 30 s, doubling to 10 min; a server `retry-after` stretches the probe at least that far. */
  markOffline(now: number, retryAfterMs?: number): OfflineLatch {
    const existing = this.readLatch();
    const backoffMs = existing === null ? OFFLINE_BACKOFF_INITIAL_MS : Math.min(existing.backoffMs * 2, OFFLINE_BACKOFF_MAX_MS);
    const latch: OfflineLatch = { since: existing?.since ?? now, nextProbeAt: now + Math.max(backoffMs, retryAfterMs ?? 0), backoffMs };
    writePrivateFileAtomic(this.latchPath(), JSON.stringify(latch));
    return latch;
  }

  clearLatch(): void {
    try { fs.unlinkSync(this.latchPath()); } catch { /* not latched */ }
  }

  // ---------------------------------------------------------------------------
  // Refusal log
  // ---------------------------------------------------------------------------

  private refusedPath(): string {
    return path.join(this.dir, REFUSED_LOG_FILE);
  }

  /** Append one refusal; the log is truncated when it would grow past its cap. Never a payload. */
  appendRefused(entry: RefusedEntry): void {
    const file = this.refusedPath();
    ensurePrivateFile(file);
    const line = JSON.stringify({ eventId: entry.eventId, sessionId: entry.sessionId, kind: entry.kind, code: entry.code, reason: entry.reason, at: entry.at }) + '\n';
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* created above */ }
    if (size + Buffer.byteLength(line) > REFUSED_LOG_MAX_BYTES) fs.writeFileSync(file, '', { mode: MEMBER_FILE_MODE });
    fs.appendFileSync(file, line, { mode: MEMBER_FILE_MODE });
  }

  readRefused(): RefusedEntry[] {
    try {
      return fs.readFileSync(this.refusedPath(), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RefusedEntry);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Drain
  // ---------------------------------------------------------------------------

  /** Upload a staged blob; null when the source has vanished (the event will be refused `blob_absent` by the server). */
  private async uploadBlob(client: ServerClient, source: BlobSource, budget: HookBudget, now: () => number, uploaded: Set<string>): Promise<Outcome | null> {
    if (uploaded.has(source.sha256)) return { class: 'acked', body: {} };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(source.path);
    } catch {
      return null;
    }
    const outcome = await client.postBlob(bytes, source.sha256, source.mediaType, clippedRequestBudget(budget, now()));
    if (outcome.class === 'acked') uploaded.add(source.sha256);
    return outcome;
  }

  /** One drain pass over a session's spool under the session lease; the high-water advances on `acked` and `refused`. */
  async drainSession(sessionId: string, client: ServerClient, budget: HookBudget, opts: DrainOptions = {}): Promise<DrainResult> {
    const now = opts.now ?? Date.now;
    const result: DrainResult = { sessionId, sent: 0, acked: 0, refused: 0, remaining: 0, endedBy: 'drained' };
    if (!budget.drains) return { ...result, skipped: 'never-drains', remaining: this.depth(sessionId) };
    if (!this.shouldDial(now(), opts.force)) return { ...result, skipped: 'latched', remaining: this.depth(sessionId) };
    ensurePrivateFile(this.leasePath(sessionId));
    const lease = LifecycleLock.acquire(this.leasePath(sessionId), { command: 'myco member drain' });
    if (!lease.acquired) return { ...result, skipped: 'lease', remaining: this.depth(sessionId) };

    try {
      const records = this.readRecords(sessionId);
      let i = readSessionState(this.dir, sessionId).highWater;
      const uploaded = new Set<string>();
      let sawUnauthorized = false;
      let retriedAfterUnauthorized = false;
      let activeClient = client;
      // How many records still reference each staged blob; the last one to be
      // drained releases the bytes. Without the count a repeat sha would be
      // unlinked under a record that has not been sent yet.
      const staged = new Map<string, number>();
      for (const record of records) {
        if (record?._blobSource) staged.set(record._blobSource.sha256, (staged.get(record._blobSource.sha256) ?? 0) + 1);
      }
      const settled = now() - longestDeclaredHookTimeoutMs();
      const release = (record: SpoolRecord | null) => {
        const source = record?._blobSource;
        if (!source) return;
        const remaining = (staged.get(source.sha256) ?? 1) - 1;
        staged.set(source.sha256, remaining);
        // `staged` counts the records this pass read. A hook still running can
        // append another record naming the same bytes, so the count is a
        // floor, not the truth — bytes younger than the longest hook timeout
        // are left for the retention sweep, which runs once nobody can.
        if (remaining > 0) return;
        // Only bytes this spool staged: a source outside the session's staging dir belongs to someone else.
        if (path.dirname(path.resolve(source.path)) !== path.resolve(this.blobsDirFor(sessionId))) return;
        try {
          if (fs.statSync(source.path).mtimeMs > settled) return;
          fs.unlinkSync(source.path);
        } catch { /* already gone */ }
      };
      const persist = (highWater: number, acked?: boolean) => updateSessionState(this.dir, sessionId, (s) => {
        s.highWater = highWater;
        if (acked) s.lastAckAt = now();
      }, now());

      pass: while (i < records.length) {
        if (!canStartRequest(budget, now())) { result.endedBy = 'budget'; break; }
        const record = records[i];
        if (record === null) {
          this.appendRefused({ eventId: '', sessionId, kind: '', code: 'refused', reason: 'unparsable spool line', at: now() });
          result.refused += 1;
          i += 1;
          persist(i);
          continue;
        }
        if (record._memberProtocol !== MEMBER_PROTOCOL) {
          stderr(`spool record ${record.eventId} was produced by member protocol ${record._memberProtocol}; this build speaks ${MEMBER_PROTOCOL} — not drained`);
          result.endedBy = 'protocol_mismatch';
          break;
        }
        if (record._blobSource) {
          const blobOutcome = await this.uploadBlob(activeClient, record._blobSource, budget, now, uploaded);
          if (blobOutcome !== null && blobOutcome.class !== 'acked' && blobOutcome.class !== 'refused') {
            result.endedBy = this.endPass(blobOutcome, now());
            break;
          }
        }
        const outcome = await activeClient.postEvent(toWire(record), clippedRequestBudget(budget, now()));
        result.sent += 1;
        switch (outcome.class) {
          case 'acked':
            this.clearLatch();
            result.acked += 1;
            i += 1;
            release(record);
            persist(i, true);
            continue;
          case 'refused':
            this.appendRefused({ eventId: record.eventId, sessionId, kind: record.kind, code: outcome.code, reason: outcome.reason, at: now() });
            stderr(`${record.kind} ${record.eventId} refused by the server (${outcome.code}): ${outcome.reason}`);
            result.refused += 1;
            i += 1;
            release(record);
            persist(i);
            continue;
          case 'reslice':
            stderr(`${record.kind} ${record.eventId} answered ${outcome.code} on the event spool — left spooled`);
            result.endedBy = outcome.class;
            break pass;
          case 'retry':
            if (outcome.anonymousLimited && sawUnauthorized) {
              result.endedBy = 'unauthorized';
              break pass;
            }
            result.endedBy = this.endPass(outcome, now());
            break pass;
          case 'unauthorized': {
            sawUnauthorized = true;
            if (!retriedAfterUnauthorized && opts.onUnauthorized && opts.clientFor) {
              retriedAfterUnauthorized = true;
              const fresh = await opts.onUnauthorized();
              if (fresh !== null) {
                activeClient = opts.clientFor(fresh);
                continue;
              }
            }
            result.endedBy = this.endPass(outcome, now());
            break pass;
          }
          default:
            result.endedBy = this.endPass(outcome, now());
            break pass;
        }
      }

      if (i >= records.length && records.length > 0) {
        const deleted = this.buffer(sessionId).deleteIfSync((fresh) => {
          if (fresh.length > i) return false;
          const state = readSessionStateUnlocked(this.dir, sessionId);
          state.highWater = 0;
          writeSessionStateUnlocked(this.dir, sessionId, state, now());
          return true;
        });
        if (!deleted) persist(i);
        result.remaining = Math.max(0, this.readRecords(sessionId).length - (deleted ? 0 : i));
      } else {
        result.remaining = records.length - i;
      }
      return result;
    } finally {
      lease.lock.release();
    }
  }

  /**
   * Side effects and the end class for an outcome that stops a pass — the one
   * place that decides what each outcome does (latch, diagnostic, neither).
   * Public because the transcript-segment path ends its own passes and must
   * not carry a second copy of the policy.
   *
   * Refusal LOGGING is not here and belongs to the caller: `refused` does not
   * end a pass on the event path (the high-water advances past it and the
   * drain continues), and only the caller holds the event whose id, kind and
   * code `refused.jsonl` records. Every caller that can be refused logs it.
   */
  endPass(outcome: Outcome, now: number): DrainEnd {
    switch (outcome.class) {
      case 'parked':
        stderr('write quota exceeded — capture parked');
        return outcome.class;
      case 'retry':
        this.markOffline(now, outcome.retryAfterMs);
        return outcome.class;
      case 'route_missing':
        stderr('server answered 401 with the protocol header on a capture route — contract bug; events stay spooled');
        this.markOffline(now);
        return outcome.class;
      case 'unauthorized':
        stderr('member token refused — re-provision (`myco member join`); events stay spooled');
        return outcome.class;
      case 'protocol':
        stderr(`server refuses member protocol ${MEMBER_PROTOCOL} (server_protocol=${outcome.serverProtocol ?? '?'}, min_compat_member_protocol=${outcome.minCompatMemberProtocol ?? '?'}) — upgrade myco; events stay spooled`);
        this.markOffline(now);
        return outcome.class;
      default:
        return outcome.class;
    }
  }

  /** Drain every session of the project in turn, inside the budget. */
  async drainAll(client: ServerClient, budget: HookBudget, opts: DrainOptions = {}): Promise<DrainResult[]> {
    const results: DrainResult[] = [];
    for (const sessionId of this.sessionIds()) {
      const r = await this.drainSession(sessionId, client, budget, opts);
      results.push(r);
      // Anything that will answer the same way for the next session ends the
      // walk: a mis-deployed server must cost one request, not one per session.
      if (r.endedBy !== 'drained' && r.endedBy !== 'reslice' && r.endedBy !== 'refused' && r.endedBy !== 'acked') break;
    }
    return results;
  }
}
