/**
 * Team Host — the MEMBER side of routed transcript capture (capture-push §5.2,
 * plan C1). The host RECEIVE side (materialization + offset gate) is C2
 * (`host/routed-transcript.ts`); this is the SEND side.
 *
 * Under Team Host a routed session's transcript file lives on the member's disk,
 * but the miner runs on the host (where the Grove DB is). This module ships the
 * transcript's append-only byte-deltas to the host materializer endpoint
 * (`POST /routed-capture/transcript`) through that host's `proxy_port`, so the
 * host has a current file to mine.
 *
 * The design is deliberately the transcript analog of the DB-free EventBuffer
 * (`capture/buffer.ts`) — a machine-scoped, filesystem-durable work-queue, NEVER
 * a Grove-DB `team_outbox` table, because an attached project has no local Grove
 * DB (§4). It carries the Team-Sync drain discipline WITHOUT the D1 transport:
 * at-least-once with host-side idempotency (the host append is idempotent by
 * offset), NO local attempt counter (a failed drain retries on the next tick),
 * NO TTL / NO cap on pending, and purge-on-detach.
 *
 * OFFSET AUTHORITY (the load-bearing invariant). The host is the offset
 * authority. On EVERY response — 200 append, 200 replay, or 409 gap — the host
 * returns its authoritative post-attempt `size`, and the member records THAT as
 * the transcript's high-water and re-slices the next send from it. It NEVER
 * advances the high-water to a locally-assumed `base + len`. Skipping this drops
 * the transcript tail on a partial-overlap replay: the member sends `[0, N)`, the
 * host already holds `[0, M)` (M<N) and answers `replay, size=M`; if the member
 * assumed `N` it would never resend `[M, N)`. Recording `M` and re-slicing from
 * it is what keeps the tail.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST_BEARER_SECRET,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_BODY_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
} from '../constants.js';
import { assertSafeCaptureSegment, resolveMemberTranscriptDrainDir } from '../grove/paths.js';
import type { GroveProjectId } from '../grove/ids.js';
import { getHost, readHostSecrets } from '../host/registry.js';
import type { RemoteTarget } from '../host/routing.js';
import { deriveTranscriptId, MAX_TRANSCRIPT_PUSH_BYTES } from '../host/routed-transcript.js';
import { defaultDial, hostProtocolCompatible, parseOverlayAddress } from '../daemon/host-proxy.js';
import type { DaemonLogger } from '../daemon/logger.js';

const NEWLINE = 0x0a;

/** One persisted work-queue entry: a transcript the member is shipping to a
 *  host, plus the host-acked high-water offset. Keyed `(host_id, session_id,
 *  transcript_id)`; `transcript_id` folds in the file's inode (C3), so a
 *  rotation mints a NEW entry and the old one goes inert. */
export interface DrainEntry {
  host_id: string;
  session_id: string;
  transcript_id: string;
  project_id: string;
  grove_id: string;
  /** Member-local absolute path to the transcript file (the durable byte source). */
  transcript_path: string;
  /** Optional symbiont metadata carried per §5.2; the host miner rediscovers the
   *  adapter from the session row, so it is informational here. */
  agent?: string;
  /** The host's last authoritative `size` for this transcript — the high-water we
   *  re-slice the next send from. Advanced ONLY to a host-returned size. */
  acked_offset: number;
  updated_at: string;
}

/** The append-delta wire body (`POST /routed-capture/transcript`; C2 contract).
 *  `bytes` is base64 for exact byte accounting. */
export interface TranscriptChunkRequest {
  machine_id: string;
  session_id: string;
  transcript_id: string;
  agent?: string;
  base_offset: number;
  bytes: string;
}

/** The host response the member acts on. `size` is the host's authoritative
 *  post-attempt byte high-water (present on 200 and 409; null only on a
 *  transport/parse failure the member treats as retry-next-tick). */
export interface TranscriptChunkResponse {
  status: number;
  size: number | null;
  action?: string;
}

/** The POST transport seam — the ONE side effect that leaves the machine. Tests
 *  inject a fake host honoring the C2 offset contract; production POSTs through
 *  the host's `proxy_port` via {@link defaultTranscriptTransport}. */
export type TranscriptPostTransport = (
  target: RemoteTarget,
  body: TranscriptChunkRequest,
) => Promise<TranscriptChunkResponse>;

/** The filesystem read seam — stat (size + inode for rotation detection) and a
 *  bounded offset read. Injectable so the drain's offset/line-split semantics are
 *  unit-testable without real disk. */
export interface TranscriptFileReader {
  stat(filePath: string): { size: number; inode: number } | null;
  readSlice(filePath: string, offset: number, length: number): Buffer;
}

/** The durable store seam over the machine-scoped queue dir. Default is the
 *  filesystem store below; tests may inject an in-memory one, though most use the
 *  fs store with `MYCO_TEAM_HOME` pointed at a tmpdir (exercising real
 *  persistence-across-restart). */
export interface DrainStore {
  list(): DrainEntry[];
  listForHost(hostId: string): DrainEntry[];
  get(hostId: string, sessionId: string, transcriptId: string): DrainEntry | null;
  put(entry: DrainEntry): void;
  remove(hostId: string, sessionId: string, transcriptId: string): void;
  /** Purge every entry for a host (purge-on-detach when the host is dropped). */
  purgeHost(hostId: string): void;
  /** Purge a single attached project's entries on a host (purge-on-detach). */
  purgeProject(hostId: string, projectId: string): void;
}

// ---------------------------------------------------------------------------
// Default filesystem store — `<member>/transcript-drain/<host>/<session>/<tid>.json`
// ---------------------------------------------------------------------------

/** True when every path segment is a filesystem-safe capture segment (the same
 *  guard the host materializer applies). A malformed id is skipped rather than
 *  allowed to escape the queue dir. */
function safeKey(hostId: string, sessionId: string, transcriptId: string): boolean {
  try {
    assertSafeCaptureSegment(hostId, 'host_id');
    assertSafeCaptureSegment(sessionId, 'session_id');
    assertSafeCaptureSegment(transcriptId, 'transcript_id');
    return true;
  } catch {
    return false;
  }
}

function entryFilePath(root: string, hostId: string, sessionId: string, transcriptId: string): string {
  return path.join(root, hostId, sessionId, `${transcriptId}.json`);
}

function readEntryFile(filePath: string): DrainEntry | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DrainEntry;
  } catch {
    return null;
  }
}

export function createFsDrainStore(rootDir: string = resolveMemberTranscriptDrainDir()): DrainStore {
  const walkFiles = (dir: string): string[] => {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walkFiles(full));
      else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
    }
    return out;
  };

  return {
    list() {
      return walkFiles(rootDir).map(readEntryFile).filter((e): e is DrainEntry => e !== null);
    },
    listForHost(hostId) {
      if (!safeKey(hostId, 'x', 'x')) return [];
      return walkFiles(path.join(rootDir, hostId)).map(readEntryFile).filter((e): e is DrainEntry => e !== null);
    },
    get(hostId, sessionId, transcriptId) {
      if (!safeKey(hostId, sessionId, transcriptId)) return null;
      return readEntryFile(entryFilePath(rootDir, hostId, sessionId, transcriptId));
    },
    put(entry) {
      if (!safeKey(entry.host_id, entry.session_id, entry.transcript_id)) return;
      const filePath = entryFilePath(rootDir, entry.host_id, entry.session_id, entry.transcript_id);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    },
    remove(hostId, sessionId, transcriptId) {
      if (!safeKey(hostId, sessionId, transcriptId)) return;
      fs.rmSync(entryFilePath(rootDir, hostId, sessionId, transcriptId), { force: true });
    },
    purgeHost(hostId) {
      if (!safeKey(hostId, 'x', 'x')) return;
      fs.rmSync(path.join(rootDir, hostId), { recursive: true, force: true });
    },
    purgeProject(hostId, projectId) {
      if (!safeKey(hostId, 'x', 'x')) return;
      for (const filePath of walkFiles(path.join(rootDir, hostId))) {
        const entry = readEntryFile(filePath);
        if (entry && entry.project_id === projectId) fs.rmSync(filePath, { force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default fs reader + POST transport
// ---------------------------------------------------------------------------

const defaultFileReader: TranscriptFileReader = {
  stat(filePath) {
    try {
      const s = fs.statSync(filePath);
      return { size: s.size, inode: Number(s.ino) };
    } catch {
      return null;
    }
  },
  readSlice(filePath, offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  },
};

/**
 * Production transport: POST the delta to the host's `/routed-capture/transcript`
 * through the SAME dial primitive the byte-opaque proxy uses ({@link defaultDial}
 * — direct for a kernel-mode member, or CONNECT-tunneled through the host's
 * `proxy_port`), attaching the host bearer + protocol-version header exactly as
 * the collect forwarder does. Reads and parses the small JSON ack.
 */
export const defaultTranscriptTransport: TranscriptPostTransport = async (target, body) => {
  const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: `${overlayHost}:${port}`,
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
  };
  const req = await defaultDial(target, { method: 'POST', path: '/routed-capture/transcript', headers });

  return new Promise<TranscriptChunkResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
    const headersTimer = setTimeout(() => fail(new Error('headers_timeout')), HOST_PROXY_HEADERS_TIMEOUT_MS);

    req.on('response', (res) => {
      clearTimeout(headersTimer);
      const bodyTimer = setTimeout(() => fail(new Error('body_timeout')), HOST_PROXY_BODY_TIMEOUT_MS);
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(bodyTimer);
        if (settled) return;
        settled = true;
        let parsed: { size?: unknown; action?: unknown } = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* non-JSON body */ }
        resolve({
          status: res.statusCode ?? 0,
          size: typeof parsed.size === 'number' ? parsed.size : null,
          action: typeof parsed.action === 'string' ? parsed.action : undefined,
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(payload);
  });
};

/** Default host-target builder for the backstop / post-restart drain, when no
 *  live {@link RemoteTarget} is on hand (the throttle/flush paths pass one). Reads
 *  the host record + bearer from the machine-global registry. */
function defaultResolveHostTarget(hostId: string, sample: DrainEntry): RemoteTarget | null {
  const host = getHost(hostId);
  if (!host) return null;
  const bearer = readHostSecrets(hostId)[HOST_BEARER_SECRET] ?? '';
  return {
    projectId: sample.project_id as GroveProjectId,
    groveId: sample.grove_id,
    host: {
      host_id: host.host_id,
      label: host.label,
      overlay_address: host.overlay_address,
      protocol_version: host.protocol_version,
      proxy_port: host.proxy_port,
    },
    bearer,
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface TranscriptDrainDeps {
  machineId: string;
  store?: DrainStore;
  transport?: TranscriptPostTransport;
  fileReader?: TranscriptFileReader;
  resolveHostTarget?: (hostId: string, sample: DrainEntry) => RemoteTarget | null;
  /** Per-POST byte cap (line-split at or below it). Default {@link MAX_TRANSCRIPT_PUSH_BYTES}. */
  chunkCapBytes?: number;
  /** Coalescing throttle for the mid-turn drain — mirrors live-reconcile's 3 s
   *  leading+trailing throttle (`capture/live-reconcile.ts`). Default 3000ms. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  logger?: Pick<DaemonLogger, 'warn'>;
}

interface HostThrottleState {
  lastRun: number;
  timer: ReturnType<typeof setTimeout> | null;
  pendingTarget: RemoteTarget | null;
}

const DEFAULT_INTERVAL_MS = 3000;
/** Safety bound on the per-entry send loop; the cap + file size bound it in
 *  practice, this only guards a pathological replay/gap oscillation. */
const MAX_DRAIN_ITERATIONS = 10_000;

export class TranscriptDrainQueue {
  private readonly machineId: string;
  private readonly store: DrainStore;
  private readonly transport: TranscriptPostTransport;
  private readonly fileReader: TranscriptFileReader;
  private readonly resolveHostTarget: (hostId: string, sample: DrainEntry) => RemoteTarget | null;
  private readonly chunkCap: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  private readonly logger?: Pick<DaemonLogger, 'warn'>;

  private readonly throttle = new Map<string, HostThrottleState>();
  /** Per-host serialization: chains drains for one host so a throttled drain, a
   *  flush, and the backstop never read/POST the same entries concurrently (the
   *  host is offset-safe either way, but serializing avoids wasted replays and
   *  lets `flushBeforeForward` await a fully-settled drain). */
  private readonly hostChains = new Map<string, Promise<void>>();

  constructor(deps: TranscriptDrainDeps) {
    this.machineId = deps.machineId;
    this.store = deps.store ?? createFsDrainStore();
    this.transport = deps.transport ?? defaultTranscriptTransport;
    this.fileReader = deps.fileReader ?? defaultFileReader;
    this.resolveHostTarget = deps.resolveHostTarget ?? defaultResolveHostTarget;
    this.chunkCap = deps.chunkCapBytes ?? MAX_TRANSCRIPT_PUSH_BYTES;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.logger = deps.logger;
  }

  /**
   * Enqueue trigger — called for every COLLECT event forwarded to a host (the
   * member-side analog of the live-reconcile tick + Stop). Ensures a queue entry
   * exists for the event's transcript at its current high-water and schedules a
   * throttled mid-turn drain. Best-effort: never throws into the collect path.
   */
  noteCollect(target: RemoteTarget, event: Record<string, unknown>): void {
    try {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
      const transcriptPath = typeof event.transcript_path === 'string' ? event.transcript_path : '';
      if (!sessionId || !transcriptPath) return;
      const agent = typeof event.agent === 'string' ? event.agent : undefined;

      const stat = this.fileReader.stat(transcriptPath);
      if (!stat) return; // no file yet — nothing to key an entry on
      const transcriptId = deriveTranscriptId({ machineId: this.machineId, transcriptPath, inode: stat.inode });

      const existing = this.store.get(target.host.host_id, sessionId, transcriptId);
      this.store.put({
        host_id: target.host.host_id,
        session_id: sessionId,
        transcript_id: transcriptId,
        project_id: target.projectId,
        grove_id: target.groveId,
        transcript_path: transcriptPath,
        agent,
        // NEVER reset the high-water: a re-enqueue for a known transcript keeps
        // its host-acked offset (offset authority §5.2).
        acked_offset: existing?.acked_offset ?? 0,
        updated_at: new Date().toISOString(),
      });
      this.scheduleThrottled(target);
    } catch (err) {
      this.logger?.warn('capture.transcript-drain', 'noteCollect failed', {
        host_id: target.host.host_id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * The `flushBeforeForward` seam the host proxy calls before forwarding a
   * terminal mining-trigger route (`/events/stop`, `/sessions/register`,
   * `/sessions/unregister`). Fully drains this host's pending transcript deltas —
   * including the final newline-less tail line — so the bytes are present when the
   * host's ingest-time mining fires (§5.3). Awaited; never throws.
   */
  async flushBeforeForward(target: RemoteTarget): Promise<void> {
    try {
      await this.runExclusive(target.host.host_id, () => this.drainHost(target.host.host_id, target, true));
    } catch (err) {
      this.logger?.warn('capture.transcript-drain', 'flushBeforeForward failed', {
        host_id: target.host.host_id,
        error: (err as Error).message,
      });
    }
  }

  /** Backstop drain across every host with pending entries (the JobRunner tick).
   *  Uses `flush:false` mid-turn semantics; the terminal completeness guarantee is
   *  {@link flushBeforeForward}'s job. Returns processed/remaining for the runner. */
  async drainAll(): Promise<{ processed: number; remaining: number }> {
    const hostIds = new Set(this.store.list().map((e) => e.host_id));
    let processed = 0;
    for (const hostId of hostIds) {
      const res = await this.runExclusive(hostId, () => this.drainHost(hostId, null, false));
      processed += res.processed;
    }
    return { processed, remaining: this.pendingCount() };
  }

  /** Count transcripts with un-shipped growth — the deep-sleep inhibitor signal
   *  (`hold.pending`, mirroring team-sync-init/job-runner). A rotated entry (the
   *  file's inode no longer matches its `transcript_id`) is NOT pending: its bytes
   *  are unreachable, so it must never hold the machine awake. */
  pendingCount(): number {
    let n = 0;
    for (const entry of this.store.list()) {
      const stat = this.fileReader.stat(entry.transcript_path);
      if (!stat) continue;
      const currentId = deriveTranscriptId({
        machineId: this.machineId,
        transcriptPath: entry.transcript_path,
        inode: stat.inode,
      });
      if (currentId !== entry.transcript_id) continue; // rotated → inert
      if (stat.size > entry.acked_offset) n += 1;
    }
    return n;
  }

  /** Purge a detached project's entries on a host (purge-on-detach, §5.2). */
  purgeProject(hostId: string, projectId: string): void {
    this.store.purgeProject(hostId, projectId);
  }

  /** Purge every entry for a host (host dropped entirely). */
  purgeHost(hostId: string): void {
    this.store.purgeHost(hostId);
  }

  /**
   * Session-terminal prune (consolidation Task C-2, item 1). Called from the
   * host-proxy's `noteSessionEnded` seam right after `flushBeforeForward` has
   * drained this host for the `/sessions/unregister` route — the member's
   * only observable session-completion signal (it holds no local
   * session-state for a routed session). Removes this session's entries that
   * are demonstrably unreachable-or-caught-up:
   *  - rotated (the file at `transcript_path` is a different inode now — the
   *    same "inert" test `drainEntry` already applies), or
   *  - fully acked (`stat.size <= acked_offset` — nothing left to ship).
   * An entry the flush could NOT catch up (transport still failing, or the
   * file briefly unreadable) is left completely alone — prune-only-acked;
   * the backstop drain keeps retrying it regardless of session end. Because
   * `pendingCount`/`drainHost` only ever iterate entries the STORE holds
   * (never independently enumerate transcript files on disk), removing a
   * caught-up entry here is safe: nothing re-discovers it as "still
   * pending" the way a file-enumerated queue would.
   */
  noteSessionEnded(hostId: string, sessionId: string): void {
    try {
      for (const entry of this.store.listForHost(hostId)) {
        if (entry.session_id !== sessionId) continue;
        const stat = this.fileReader.stat(entry.transcript_path);
        if (!stat) continue; // can't prove caught-up — leave for the next drain tick
        const currentId = deriveTranscriptId({
          machineId: this.machineId,
          transcriptPath: entry.transcript_path,
          inode: stat.inode,
        });
        const inert = currentId !== entry.transcript_id;
        const caughtUp = stat.size <= entry.acked_offset;
        if (inert || caughtUp) {
          this.store.remove(entry.host_id, entry.session_id, entry.transcript_id);
        }
      }
    } catch (err) {
      this.logger?.warn('capture.transcript-drain', 'noteSessionEnded failed', {
        host_id: hostId,
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  }

  /** The deps object both dispatch chokepoints thread into `handleAttachedRequest`
   *  (`daemon/server.ts`, `mcp/http.ts`): the flush-before-terminal-route seam, the
   *  collect enqueue trigger, and the session-terminal prune trigger. */
  proxyDeps(): {
    flushBeforeForward: (target: RemoteTarget) => Promise<void>;
    noteCollectEvent: (target: RemoteTarget, event: Record<string, unknown>) => void;
    noteSessionEnded: (target: RemoteTarget, sessionId: string) => void;
  } {
    return {
      flushBeforeForward: (target) => this.flushBeforeForward(target),
      noteCollectEvent: (target, event) => this.noteCollect(target, event),
      noteSessionEnded: (target, sessionId) => this.noteSessionEnded(target.host.host_id, sessionId),
    };
  }

  // --- internals ---

  private scheduleThrottled(target: RemoteTarget): void {
    const hostId = target.host.host_id;
    const ts = this.now();
    let st = this.throttle.get(hostId);
    if (!st) {
      st = { lastRun: 0, timer: null, pendingTarget: null };
      this.throttle.set(hostId, st);
    }
    const elapsed = ts - st.lastRun;
    const fire = (t: RemoteTarget) => {
      st!.lastRun = this.now();
      st!.pendingTarget = null;
      void this.runExclusive(hostId, () => this.drainHost(hostId, t, false)).catch(() => { /* logged in drainHost */ });
    };
    if (elapsed >= this.intervalMs && st.timer === null) {
      fire(target); // leading edge
      return;
    }
    st.pendingTarget = target;
    if (st.timer === null) {
      const delay = Math.max(0, this.intervalMs - elapsed);
      st.timer = this.setTimer(() => {
        st!.timer = null;
        if (st!.pendingTarget) fire(st!.pendingTarget);
      }, delay);
    }
  }

  /** Serialize all drains for one host onto a single promise chain. */
  private runExclusive<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.hostChains.get(hostId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the chain alive but swallow settle so a rejection never poisons the next link.
    this.hostChains.set(hostId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async drainHost(
    hostId: string,
    target: RemoteTarget | null,
    flush: boolean,
  ): Promise<{ processed: number; remaining: number }> {
    const entries = this.store.listForHost(hostId);
    if (entries.length === 0) return { processed: 0, remaining: 0 };

    const t = target ?? this.resolveHostTarget(hostId, entries[0]);
    if (!t) return { processed: 0, remaining: entries.length }; // host record gone; leave entries

    // A version-incompatible host never self-heals by retry — skip (the entries
    // stay pending; the drain re-checks after an upgrade + reconnect).
    if (!hostProtocolCompatible(t.host.protocol_version)) {
      this.logger?.warn('capture.transcript-drain', 'host protocol incompatible — drain skipped', {
        host_id: hostId,
        host_protocol: t.host.protocol_version,
      });
      return { processed: 0, remaining: entries.length };
    }

    let processed = 0;
    for (const entry of entries) {
      processed += await this.drainEntry(t, entry, flush);
    }
    return { processed, remaining: this.pendingCount() };
  }

  /**
   * Ship one transcript's un-shipped bytes to the host, capped + line-split, in
   * offset order. Loops until caught up (or a transport failure — retry next
   * tick). Records the host's returned `size` as the new high-water on every
   * response (offset authority) so a partial-overlap replay re-slices from the
   * host's size and the tail is never dropped.
   */
  private async drainEntry(target: RemoteTarget, entry: DrainEntry, flush: boolean): Promise<number> {
    let sent = 0;
    for (let iter = 0; iter < MAX_DRAIN_ITERATIONS; iter += 1) {
      const stat = this.fileReader.stat(entry.transcript_path);
      if (!stat) return sent; // file missing — retry next tick while it exists

      const currentId = deriveTranscriptId({
        machineId: this.machineId,
        transcriptPath: entry.transcript_path,
        inode: stat.inode,
      });
      if (currentId !== entry.transcript_id) {
        // Rotation: the file at this path is a different inode now. The old
        // transcript's remaining bytes are unreachable — remove the inert entry
        // (a fresh enqueue keys the new inode). Bounds the store; never drops a
        // shippable byte (there is none left to ship).
        this.store.remove(entry.host_id, entry.session_id, entry.transcript_id);
        return sent;
      }

      const base = entry.acked_offset;
      if (base >= stat.size) return sent; // caught up

      const windowLen = Math.min(this.chunkCap, stat.size - base);
      const buf = this.fileReader.readSlice(entry.transcript_path, base, windowLen);
      if (buf.length === 0) return sent;
      const reachedEof = base + buf.length >= stat.size;

      const sendLen = this.pickSendLength(buf, reachedEof, flush);
      if (sendLen === 0) return sent; // only an incomplete final line — wait for it to complete

      const bytes = buf.subarray(0, sendLen).toString('base64');
      let resp: TranscriptChunkResponse;
      try {
        resp = await this.transport(target, {
          machine_id: this.machineId,
          session_id: entry.session_id,
          transcript_id: entry.transcript_id,
          agent: entry.agent,
          base_offset: base,
          bytes,
        });
      } catch (err) {
        this.logger?.warn('capture.transcript-drain', 'transcript POST failed — retry next tick', {
          host_id: entry.host_id,
          session_id: entry.session_id,
          error: (err as Error).message,
        });
        return sent; // leave acked_offset unchanged (prune-only-acked); retry next tick
      }
      sent += 1;

      // OFFSET AUTHORITY: record the host's returned size on 200 (append OR
      // replay) and 409 (gap) alike, then re-slice from it. Never advance to a
      // locally-assumed base+len — that is the tail-drop bug.
      if ((resp.status === 200 || resp.status === 409) && resp.size !== null) {
        if (resp.size === base && resp.status === 200 && resp.action !== 'replay') {
          // Defensive: an append that reported no growth would loop forever.
          this.logger?.warn('capture.transcript-drain', 'append reported no progress — stopping', {
            host_id: entry.host_id, session_id: entry.session_id, base,
          });
          return sent;
        }
        entry.acked_offset = resp.size;
        this.store.put(entry);
      } else {
        this.logger?.warn('capture.transcript-drain', 'unexpected host response — retry next tick', {
          host_id: entry.host_id, session_id: entry.session_id, status: resp.status,
        });
        return sent;
      }
    }
    return sent;
  }

  /**
   * How many bytes of the read window to send this pass:
   *  - capped (did not reach EOF): send whole lines up to the last newline; if the
   *    window holds no newline (a single line longer than the cap), send the raw
   *    cap so the drain still makes progress (the host is byte-agnostic; the miner
   *    completes the line when the rest arrives).
   *  - reached EOF, flush=true (terminal route): send everything, including a final
   *    line with no trailing newline — the turn is done, so the last line is
   *    complete and the miner parses it.
   *  - reached EOF, flush=false (mid-turn): send only complete lines; hold back an
   *    incomplete final line still being written (0 when the whole tail is one
   *    incomplete line), picking it up once a newline lands.
   */
  private pickSendLength(buf: Buffer, reachedEof: boolean, flush: boolean): number {
    if (!reachedEof) {
      const lastNl = buf.lastIndexOf(NEWLINE);
      return lastNl >= 0 ? lastNl + 1 : buf.length;
    }
    if (flush) return buf.length;
    const lastNl = buf.lastIndexOf(NEWLINE);
    return lastNl >= 0 ? lastNl + 1 : 0;
  }
}

/** Build the member transcript-content drain queue (capture-push §5.2, C1). */
export function createTranscriptDrainQueue(deps: TranscriptDrainDeps): TranscriptDrainQueue {
  return new TranscriptDrainQueue(deps);
}
