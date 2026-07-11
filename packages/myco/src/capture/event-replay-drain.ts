/**
 * Team Host — the attach-aware LIVE-EVENT replay drain (capture-push §7 task 5,
 * plan C5). The append half is already built: the host proxy's collect path
 * durably buffers every live capture event to the DB-free collector buffer
 * (`capture/buffer.ts`, dir resolved by `resolveProjectBufferDir`) when the host
 * is unreachable. This module is the REPLAY half — on the next tick it re-forwards
 * those buffered events over the overlay to the host so the host's own replay-
 * tolerant capture handlers converge them.
 *
 * THE BLIND SPOT THIS FIXES. The daemon's existing buffer reconciler enumerates
 * LOCAL groves only (`listAllProjectBufferDirs` → `listGroves`) and REPLAYS INTO A
 * LOCAL GROVE DB. An attached project has neither — no `listGroves` entry and no
 * local DB — so the reconciler never sees its buffer, and local reconciliation
 * would violate never-materialize even if it did. This drain instead enumerates
 * the ATTACH REGISTRY (`readHostRegistry`), resolves each attached project's
 * buffer dir DB-free (`resolveProjectBufferDir(groveId, projectId)` — NEVER the
 * hook-style `ensureProjectRegistered` path that would materialize a local Grove),
 * and RE-FORWARDS each event through that host's proxy to the host, which re-runs
 * its own replay-tolerant handlers against ITS Grove DB. No local grove, no local
 * DB, no local reconciliation.
 *
 * ROUTE-CORRECT REPLAY. The collector buffer holds bodies from all five collect
 * routes (`/events`, `/events/stop`, `/sessions/register`, `/sessions/unregister`,
 * `/events/sync-transcript-prompts`), and the host's per-route handlers are not
 * interchangeable — `/events` rejects a body with no `type`. So each record is
 * re-forwarded to the SAME route it was captured on, recorded by the proxy's
 * append stamp (`capture/collect-buffer-route.ts`) and stripped before forwarding.
 *
 * DRAIN DISCIPLINE (carried from team-sync / the C1 transcript drain, WITHOUT the
 * D1 transport): at-least-once with host-side idempotency — every host handler is
 * replay-tolerant, so a duplicate re-forward is safe; a per-`(host, session)`
 * high-water (the count of records the host has acked) is advanced ONLY after a 2xx
 * ack and persisted machine-scoped so it survives restart; NO local attempt
 * counter / NO backoff (a failed forward leaves the high-water put and retries on
 * the next tick); NO TTL / NO cap on pending; and purge-on-detach.
 *
 * The high-water is a machine-scoped filesystem store, NOT a Grove-DB table — an
 * attached project has no local Grove DB (§4), so this mirrors the DB-free
 * EventBuffer and the C1 transcript drain's own queue.
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
import { EventBuffer, listBufferSessionIds } from './buffer.js';
import {
  DEFAULT_COLLECT_ROUTE,
  readCollectRoute,
  stripCollectRoute,
} from './collect-buffer-route.js';
import type { GroveProjectId } from '../grove/ids.js';
import {
  assertSafeCaptureSegment,
  resolveMemberEventReplayDrainDir,
  resolveProjectBufferDir,
} from '../grove/paths.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { readHostRegistry, readHostSecrets } from '../host/registry.js';
import type { RemoteTarget } from '../host/routing.js';
import { defaultDial, hostProtocolCompatible, parseOverlayAddress } from '../daemon/host-proxy.js';
import type { DaemonLogger } from '../daemon/logger.js';

/** One persisted high-water entry: how many of an attached session's collector-
 *  buffer records the host has already acked. Keyed `(host_id, session_id)`. */
export interface ReplayEntry {
  host_id: string;
  project_id: string;
  session_id: string;
  /** Count of leading buffer records the host has acked — replay resumes here. */
  acked_count: number;
  updated_at: string;
}

/** One attached project to drain: its host round-trip target plus the DB-free
 *  collector buffer dir. The enumeration source is the ATTACH REGISTRY, never
 *  `listGroves`. */
export interface AttachedReplayTarget {
  hostId: string;
  projectId: string;
  target: RemoteTarget;
  bufferDir: string;
}

/** The re-forward transport seam — the ONE side effect that leaves the machine.
 *  Tests inject a fake host sink; production POSTs through the host's `proxy_port`
 *  ({@link defaultEventReplayTransport}). Resolves the host's HTTP status; a 2xx is
 *  the ack that advances the high-water. */
export type EventReplayTransport = (
  target: RemoteTarget,
  route: string,
  sessionId: string,
  body: Record<string, unknown>,
) => Promise<{ status: number }>;

/** The attach-registry enumeration seam. Default reads the machine-global host
 *  registry; tests inject a fixed list. */
export type AttachedTargetLister = () => AttachedReplayTarget[];

/** The collector-buffer read seam (list sessions + read a session's records in
 *  order). Injectable so the drain's high-water/skip semantics are unit-testable
 *  without real disk. */
export interface CollectBufferReader {
  listSessions(bufferDir: string): string[];
  readRecords(bufferDir: string, sessionId: string): Record<string, unknown>[];
  /** Cheap change-detection signal for a session's buffer file (consolidation
   *  Task C-2, item 5 — `pendingCount` used to re-parse every attached
   *  session's full buffer on every poll, a hot path the deep-sleep-inhibitor
   *  hits repeatedly). `null` when the file doesn't exist. */
  statSession(bufferDir: string, sessionId: string): { size: number; mtimeMs: number } | null;
}

/** The durable high-water store seam over the machine-scoped queue dir. Default is
 *  the filesystem store below. */
export interface ReplayStore {
  get(hostId: string, sessionId: string): ReplayEntry | null;
  put(entry: ReplayEntry): void;
  remove(hostId: string, sessionId: string): void;
  /** Purge every entry for a host (host dropped entirely). */
  purgeHost(hostId: string): void;
  /** Purge one attached project's entries on a host (purge-on-detach, §5.2). */
  purgeProject(hostId: string, projectId: string): void;
  list(): ReplayEntry[];
}

// ---------------------------------------------------------------------------
// Default attach-registry enumeration (NOT listGroves)
// ---------------------------------------------------------------------------

/**
 * Enumerate attached projects from the machine-global attach registry — the ONLY
 * enumeration source (never `listGroves`). One target per attach ref, its buffer
 * dir resolved DB-free from the ref's `(grove_id, project_id)` via
 * {@link resolveProjectBufferDir}. A host with no bearer on file yields an empty
 * bearer; the version/reachability guards downstream leave its entries pending.
 */
export function listAttachedReplayTargets(): AttachedReplayTarget[] {
  const out: AttachedReplayTarget[] = [];
  for (const record of readHostRegistry()) {
    const bearer = readHostSecrets(record.host_id)[HOST_BEARER_SECRET] ?? '';
    for (const ref of record.projects) {
      out.push({
        hostId: record.host_id,
        projectId: ref.project_id,
        target: {
          projectId: ref.project_id as GroveProjectId,
          groveId: ref.grove_id,
          host: {
            host_id: record.host_id,
            label: record.label,
            overlay_address: record.overlay_address,
            protocol_version: record.protocol_version,
            proxy_port: record.proxy_port,
          },
          bearer,
        },
        bufferDir: resolveProjectBufferDir(ref.grove_id, ref.project_id),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default collector-buffer reader
// ---------------------------------------------------------------------------

/** The collector-buffer file path for a session — shared by the reader and the
 *  stat-based change-detection signal below. */
function bufferFilePath(bufferDir: string, sessionId: string): string {
  return path.join(bufferDir, `${sessionId}.jsonl`);
}

/** Cheap size+mtime probe for a session's buffer file (item 5's change-detection
 *  signal) — `null` when the file doesn't exist yet. */
function statBufferFile(bufferDir: string, sessionId: string): { size: number; mtimeMs: number } | null {
  try {
    const s = fs.statSync(bufferFilePath(bufferDir, sessionId));
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Read a session's collector-buffer records in order, tolerant of an in-flight
 *  torn trailing line: parse each JSONL line and STOP at the first that fails to
 *  parse (a flock-atomic append still completing). The parsed prefix is index-
 *  stable — the high-water counts leading records — so stopping never mis-aligns
 *  the resume point; the torn line completes and is picked up next tick. */
function readBufferRecords(bufferDir: string, sessionId: string): Record<string, unknown>[] {
  const filePath = bufferFilePath(bufferDir, sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      break; // torn trailing line still being appended — resume next tick
    }
  }
  return out;
}

const defaultBufferReader: CollectBufferReader = {
  listSessions: (bufferDir) => listBufferSessionIds(bufferDir),
  readRecords: (bufferDir, sessionId) => readBufferRecords(bufferDir, sessionId),
  statSession: (bufferDir, sessionId) => statBufferFile(bufferDir, sessionId),
};

// ---------------------------------------------------------------------------
// Default filesystem store — `<member>/event-replay-drain/<host>/<session>.json`
// ---------------------------------------------------------------------------

/** True when both key segments are filesystem-safe (the same guard the host
 *  materializer + transcript drain apply). A malformed id is skipped rather than
 *  allowed to escape the queue dir. */
function safeKey(hostId: string, sessionId: string): boolean {
  try {
    assertSafeCaptureSegment(hostId, 'host_id');
    assertSafeCaptureSegment(sessionId, 'session_id');
    return true;
  } catch {
    return false;
  }
}

function entryFilePath(root: string, hostId: string, sessionId: string): string {
  return path.join(root, hostId, `${sessionId}.json`);
}

function readEntryFile(filePath: string): ReplayEntry | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReplayEntry;
  } catch {
    return null;
  }
}

export function createFsReplayStore(rootDir: string = resolveMemberEventReplayDrainDir()): ReplayStore {
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
    get(hostId, sessionId) {
      if (!safeKey(hostId, sessionId)) return null;
      return readEntryFile(entryFilePath(rootDir, hostId, sessionId));
    },
    put(entry) {
      if (!safeKey(entry.host_id, entry.session_id)) return;
      const filePath = entryFilePath(rootDir, entry.host_id, entry.session_id);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    },
    remove(hostId, sessionId) {
      if (!safeKey(hostId, sessionId)) return;
      const filePath = entryFilePath(rootDir, hostId, sessionId);
      fs.rmSync(filePath, { force: true });
      // Reap a torn `.tmp` sibling left by a crash mid-put (write-then-rename)
      // — otherwise it outlives the entry it belonged to.
      fs.rmSync(`${filePath}.tmp`, { force: true });
    },
    purgeHost(hostId) {
      if (!safeKey(hostId, 'x')) return;
      fs.rmSync(path.join(rootDir, hostId), { recursive: true, force: true });
    },
    purgeProject(hostId, projectId) {
      if (!safeKey(hostId, 'x')) return;
      for (const filePath of walkFiles(path.join(rootDir, hostId))) {
        const entry = readEntryFile(filePath);
        if (entry && entry.project_id === projectId) {
          fs.rmSync(filePath, { force: true });
          fs.rmSync(`${filePath}.tmp`, { force: true }); // torn-put sibling
        }
      }
    },
    list() {
      return walkFiles(rootDir).map(readEntryFile).filter((e): e is ReplayEntry => e !== null);
    },
  };
}

// ---------------------------------------------------------------------------
// Default POST transport
// ---------------------------------------------------------------------------

/**
 * Production transport: re-forward one buffered body to the host `route` through
 * the SAME dial primitive the byte-opaque proxy uses ({@link defaultDial} — direct
 * for a kernel-mode member, or CONNECT-tunneled through the host's `proxy_port`),
 * attaching the host bearer + protocol-version header exactly as the live collect
 * forward does, plus the tenancy headers the host resolves the hosted Grove from
 * (project/grove/machine/session). `hostServed` is derived host-side from the
 * request arriving on the overlay listener — never a header. The host injects its
 * own `x-myco-auth` for overlay requests, so the stripped tenancy headers resolve
 * as claims under v1 flat trust (`daemon/server.ts` overlay handler).
 */
function makeDefaultTransport(machineId: string): EventReplayTransport {
  return async (target, route, sessionId, body) => {
    const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const headers: Record<string, string> = {
      host: `${overlayHost}:${port}`,
      authorization: `Bearer ${target.bearer}`,
      'content-type': 'application/json',
      'content-length': String(payload.length),
      [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
      [REQUEST_CONTEXT_HEADERS.projectId]: target.projectId,
      [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
      [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
      [REQUEST_CONTEXT_HEADERS.sessionId]: sessionId,
    };
    const req = await defaultDial(target, { method: 'POST', path: route, headers });

    return new Promise<{ status: number }>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
      const headersTimer = setTimeout(() => fail(new Error('headers_timeout')), HOST_PROXY_HEADERS_TIMEOUT_MS);
      req.on('response', (res) => {
        clearTimeout(headersTimer);
        const bodyTimer = setTimeout(() => fail(new Error('body_timeout')), HOST_PROXY_BODY_TIMEOUT_MS);
        res.on('data', () => { /* drain + discard; only the status matters */ });
        res.on('end', () => {
          clearTimeout(bodyTimer);
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0 });
        });
        res.on('error', fail);
      });
      req.on('error', fail);
      req.end(payload);
    });
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface EventReplayDrainDeps {
  machineId: string;
  store?: ReplayStore;
  transport?: EventReplayTransport;
  bufferReader?: CollectBufferReader;
  listTargets?: AttachedTargetLister;
  /** LOCKED conditional removal of a session's collector-buffer file
   *  (consolidation Task C-2, item 6). Implementations MUST hold the same
   *  per-session flock `EventBuffer.append()` takes, RE-READ the buffer
   *  inside the lock, and delete only when `shouldDelete` approves the
   *  re-read records — the hook-fallback subprocess (`hooks/send-event.ts`
   *  buffering via `resolveProjectBufferDirFromRoot`) is a real cross-process
   *  appender to this exact file for attached projects, and an unlocked
   *  check-then-delete destroys a straggler append landing between the check
   *  and the unlink (never-acked, never-forwarded bytes, unrecoverable once
   *  the high-water entry is removed with the file). Default is
   *  `EventBuffer.deleteIfSync`, which is exactly that contract. Returns
   *  true when the file was deleted. Injectable so unit tests can drive the
   *  refusal semantics against an in-memory buffer. */
  deleteSessionBuffer?: (
    bufferDir: string,
    sessionId: string,
    shouldDelete: (records: Record<string, unknown>[]) => boolean,
  ) => boolean;
  logger?: Pick<DaemonLogger, 'warn'>;
}

const LOG_CATEGORY = 'capture.event-replay-drain';

export class EventReplayDrainQueue {
  private readonly machineId: string;
  private readonly store: ReplayStore;
  private readonly transport: EventReplayTransport;
  private readonly bufferReader: CollectBufferReader;
  private readonly listTargets: AttachedTargetLister;
  private readonly deleteSessionBuffer: (
    bufferDir: string,
    sessionId: string,
    shouldDelete: (records: Record<string, unknown>[]) => boolean,
  ) => boolean;
  private readonly logger?: Pick<DaemonLogger, 'warn'>;

  /** Reentrancy guard: the backstop job is the sole caller, but a slow drain must
   *  not overlap the next tick's invocation (both would read the same buffers and
   *  race the high-water store; the host is idempotent, so overlap is safe but
   *  wasteful). */
  private draining = false;

  /** `pendingCount` change-detection cache (item 5): `bufferDir::sessionId` →
   *  the size/mtime this drain last saw plus the record count it computed from
   *  that state. A poll whose current stat matches the cache reuses `total`
   *  instead of re-parsing the whole buffer — the common case between bursts
   *  of activity, since `hold.pending` is polled far more often than a buffer
   *  actually grows. Purely a runtime memo; never persisted, never a substitute
   *  for the durable `ReplayStore` high-water. */
  private readonly countCache = new Map<string, { size: number; mtimeMs: number; total: number }>();

  constructor(deps: EventReplayDrainDeps) {
    this.machineId = deps.machineId;
    this.store = deps.store ?? createFsReplayStore();
    this.transport = deps.transport ?? makeDefaultTransport(deps.machineId);
    this.bufferReader = deps.bufferReader ?? defaultBufferReader;
    this.listTargets = deps.listTargets ?? listAttachedReplayTargets;
    this.deleteSessionBuffer = deps.deleteSessionBuffer
      ?? ((bufferDir, sessionId, shouldDelete) => new EventBuffer(bufferDir, sessionId).deleteIfSync(shouldDelete));
    this.logger = deps.logger;
  }

  /**
   * Drain every attached project's un-shipped collector-buffer events to its host.
   * Retry-on-tick IS the reconnect trigger: an unreachable host leaves entries
   * pending and the next tick re-forwards them. Returns processed/remaining for
   * the JobRunner.
   */
  async drainAll(): Promise<{ processed: number; remaining: number }> {
    if (this.draining) return { processed: 0, remaining: this.pendingCount() };
    this.draining = true;
    let processed = 0;
    try {
      for (const attached of this.listTargets()) {
        processed += await this.drainTarget(attached);
      }
    } finally {
      this.draining = false;
    }
    return { processed, remaining: this.pendingCount() };
  }

  /** Count attached sessions with events past their acked high-water — the signal
   *  for the deep-sleep inhibitor (`hold.pending`) so the machine never sleeps on
   *  un-shipped capture. Best-effort read; never throws.
   *
   *  Item 5 (consolidation Task C-2): a full `readRecords` re-parse is skipped
   *  when the buffer file's size+mtime match what this drain saw on the LAST
   *  poll — `hold.pending` is checked far more often than a buffer actually
   *  grows, so the common case becomes a cheap `statSync` instead of parsing
   *  every JSONL line in every attached session's buffer on every tick. */
  pendingCount(): number {
    let n = 0;
    for (const attached of this.safeTargets()) {
      for (const sessionId of this.safeSessions(attached.bufferDir)) {
        const total = this.cachedRecordCount(attached.bufferDir, sessionId);
        if (total === null) continue; // file vanished since listSessions — nothing to count
        const acked = this.store.get(attached.hostId, sessionId)?.acked_count ?? 0;
        if (total > acked) n += 1;
      }
    }
    return n;
  }

  /** Purge a detached project's high-water entries on a host (purge-on-detach). */
  purgeProject(hostId: string, projectId: string): void {
    this.store.purgeProject(hostId, projectId);
    this.countCache.clear(); // conservative — the purged project's cache keys are unknown here
  }

  /** Purge every high-water entry for a host (host dropped entirely). */
  purgeHost(hostId: string): void {
    this.store.purgeHost(hostId);
    this.countCache.clear();
  }

  /**
   * Session-terminal prune (consolidation Task C-2, item 6). Called from the
   * host-proxy's `noteSessionEnded` seam right after `flushBeforeForward` has
   * drained the transcript/plan queues for this host's `/sessions/unregister`
   * route.
   *
   * UNLIKE those two queues, this one has no `flushBeforeForward` of its own —
   * it is deliberately backstop-only (driven purely by the JobRunner tick; see
   * the class doc). That matters here: `bufferAppend` has ALREADY written the
   * `/sessions/unregister` record itself to this session's buffer (the collect
   * dispatch chokepoint appends every collect event before forwarding), so
   * without an explicit drain right here, that record is virtually always
   * still un-acked at the instant this one-shot check runs — the backstop
   * tick that would normally ack it hasn't fired yet. A prune gated on
   * "already caught up" would then almost NEVER fire, defeating the point.
   * So this drains this ONE session synchronously first (mirroring what
   * `flushBeforeForward` gives the other two queues for free), THEN checks.
   *
   * Also unlike the transcript/plan drains (`noteSessionEnded` there), this
   * queue cannot prune the high-water entry ALONE even once caught up:
   * `pendingCount`/`drainSession` both re-discover a session by enumerating
   * the collector-buffer FILES (`listSessions`), not by iterating stored
   * entries — and nothing else in this codebase ever deletes an attached
   * project's buffer file (the header docstring's "blind spot"). Removing
   * only the `ReplayEntry` would make the very next poll see the buffer's
   * full record count against an (unrecorded) acked count of 0 — re-counted
   * as pending, and the next backstop tick would re-forward every record —
   * FOREVER, since the file never goes away on its own. So a caught-up
   * session's prune deletes BOTH the buffer file AND the `ReplayEntry`
   * together, and only when every buffered record is acked. A session the
   * drain could NOT catch up (host still unreachable) is left completely
   * untouched — prune-only-acked; the backstop drain keeps retrying it
   * regardless of session end.
   *
   * DELETE-UNDER-LOCK (the straggler-append invariant): the file removal
   * goes through {@link EventReplayDrainDeps.deleteSessionBuffer} (default
   * `EventBuffer.deleteIfSync`), which holds the SAME per-session flock
   * `EventBuffer.append()` takes, RE-READS the buffer inside the lock, and
   * re-runs the acked check against THAT read before unlinking. The
   * pre-check below is only a cheap early-out; the decision that authorizes
   * the unlink is the locked re-read's. A straggler append (hook-fallback
   * subprocess racing this prune) therefore either lands before the lock —
   * the locked re-read counts it, the check refuses, the entry stays and the
   * backstop retries later — or blocks on the flock until the delete
   * decision is made. An unlocked check-then-delete here destroyed exactly
   * that straggler: never-acked, never-forwarded bytes, unrecoverable once
   * the `ReplayEntry` went with the file.
   */
  async noteSessionEnded(target: RemoteTarget, sessionId: string): Promise<void> {
    try {
      const hostId = target.host.host_id;
      const bufferDir = resolveProjectBufferDir(target.groveId, target.projectId);
      if (hostProtocolCompatible(target.host.protocol_version)) {
        await this.drainSession({ hostId, projectId: target.projectId, target, bufferDir }, sessionId);
      }
      // Cheap unlocked early-out only — the authoritative check is the locked
      // re-read inside deleteSessionBuffer below.
      const records = this.bufferReader.readRecords(bufferDir, sessionId);
      if (records.length === 0) return; // nothing buffered (or already pruned) — no-op
      const acked = this.store.get(hostId, sessionId)?.acked_count ?? 0;
      if (acked < records.length) return; // still not caught up (host unreachable) — leave for the backstop
      const deleted = this.deleteSessionBuffer(bufferDir, sessionId, (lockedRecords) => {
        // Runs INSIDE the flock against the re-read state the unlink will act
        // on. Re-fetch the acked count too — the outer read is pre-lock.
        const ackedNow = this.store.get(hostId, sessionId)?.acked_count ?? 0;
        return ackedNow >= lockedRecords.length;
      });
      if (!deleted) return; // straggler landed (or file gone) — entry stays; backstop retries
      this.store.remove(hostId, sessionId);
      this.countCache.delete(`${bufferDir}::${sessionId}`);
    } catch (err) {
      this.logger?.warn(LOG_CATEGORY, 'noteSessionEnded failed', {
        host_id: target.host.host_id,
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  }

  // --- internals ---

  /** Item 5's cached record count for one session's buffer — `null` when the
   *  file doesn't exist. Recomputes (and re-caches) only when the file's
   *  size/mtime differ from the last observation. */
  private cachedRecordCount(bufferDir: string, sessionId: string): number | null {
    const stat = this.bufferReader.statSession(bufferDir, sessionId);
    const key = `${bufferDir}::${sessionId}`;
    if (!stat) {
      this.countCache.delete(key);
      return null;
    }
    const cached = this.countCache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.total;
    }
    const total = this.bufferReader.readRecords(bufferDir, sessionId).length;
    this.countCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, total });
    return total;
  }

  private safeTargets(): AttachedReplayTarget[] {
    try { return this.listTargets(); } catch { return []; }
  }

  private safeSessions(bufferDir: string): string[] {
    try { return this.bufferReader.listSessions(bufferDir); } catch { return []; }
  }

  private async drainTarget(attached: AttachedReplayTarget): Promise<number> {
    // A version-incompatible host never self-heals by retry — leave its entries
    // pending; the drain re-checks after an upgrade + reconnect.
    if (!hostProtocolCompatible(attached.target.host.protocol_version)) {
      this.logger?.warn(LOG_CATEGORY, 'host protocol incompatible — replay drain skipped', {
        host_id: attached.hostId,
        host_protocol: attached.target.host.protocol_version,
      });
      return 0;
    }
    let processed = 0;
    for (const sessionId of this.safeSessions(attached.bufferDir)) {
      processed += await this.drainSession(attached, sessionId);
    }
    return processed;
  }

  /**
   * Re-forward one session's un-shipped buffer records to the host, in order,
   * each to its own captured route. Advances the persisted high-water ONLY after a
   * 2xx ack; a non-2xx or a transport failure stops the session (retry next tick),
   * leaving the high-water where it stands — the at-least-once guarantee, safe
   * because every host handler is replay-tolerant.
   */
  private async drainSession(attached: AttachedReplayTarget, sessionId: string): Promise<number> {
    const records = this.bufferReader.readRecords(attached.bufferDir, sessionId);
    let acked = this.store.get(attached.hostId, sessionId)?.acked_count ?? 0;
    if (acked > records.length) acked = records.length; // buffer shrank (unexpected) — clamp
    if (records.length <= acked) return 0; // caught up

    let sent = 0;
    for (let i = acked; i < records.length; i += 1) {
      const record = records[i];
      const route = readCollectRoute(record) ?? DEFAULT_COLLECT_ROUTE;
      const body = stripCollectRoute(record);
      let status: number;
      try {
        ({ status } = await this.transport(attached.target, route, sessionId, body));
      } catch (err) {
        this.logger?.warn(LOG_CATEGORY, 'replay forward failed — retry next tick', {
          host_id: attached.hostId,
          session_id: sessionId,
          route,
          error: (err as Error).message,
        });
        break; // leave high-water; retry next tick (no attempt counter, no backoff)
      }
      sent += 1;
      if (status >= 200 && status < 300) {
        acked = i + 1;
        this.persist(attached, sessionId, acked);
      } else {
        this.logger?.warn(LOG_CATEGORY, 'host rejected replay forward — retry next tick', {
          host_id: attached.hostId,
          session_id: sessionId,
          route,
          status,
        });
        break; // do NOT advance past a rejected record; retry next tick
      }
    }
    return sent;
  }

  private persist(attached: AttachedReplayTarget, sessionId: string, ackedCount: number): void {
    this.store.put({
      host_id: attached.hostId,
      project_id: attached.projectId,
      session_id: sessionId,
      acked_count: ackedCount,
      updated_at: new Date().toISOString(),
    });
  }
}

/** Build the member-side attach-aware live-event replay drain (capture-push §7
 *  task 5, plan C5). */
export function createEventReplayDrainQueue(deps: EventReplayDrainDeps): EventReplayDrainQueue {
  return new EventReplayDrainQueue(deps);
}
