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
import { listBufferSessionIds } from './buffer.js';
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

/** Read a session's collector-buffer records in order, tolerant of an in-flight
 *  torn trailing line: parse each JSONL line and STOP at the first that fails to
 *  parse (a flock-atomic append still completing). The parsed prefix is index-
 *  stable — the high-water counts leading records — so stopping never mis-aligns
 *  the resume point; the torn line completes and is picked up next tick. */
function readBufferRecords(bufferDir: string, sessionId: string): Record<string, unknown>[] {
  const filePath = path.join(bufferDir, `${sessionId}.jsonl`);
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
      fs.rmSync(entryFilePath(rootDir, hostId, sessionId), { force: true });
    },
    purgeHost(hostId) {
      if (!safeKey(hostId, 'x')) return;
      fs.rmSync(path.join(rootDir, hostId), { recursive: true, force: true });
    },
    purgeProject(hostId, projectId) {
      if (!safeKey(hostId, 'x')) return;
      for (const filePath of walkFiles(path.join(rootDir, hostId))) {
        const entry = readEntryFile(filePath);
        if (entry && entry.project_id === projectId) fs.rmSync(filePath, { force: true });
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
  return (target, route, sessionId, body) => {
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
    const req = defaultDial(target, { method: 'POST', path: route, headers });

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
  logger?: Pick<DaemonLogger, 'warn'>;
}

const LOG_CATEGORY = 'capture.event-replay-drain';

export class EventReplayDrainQueue {
  private readonly machineId: string;
  private readonly store: ReplayStore;
  private readonly transport: EventReplayTransport;
  private readonly bufferReader: CollectBufferReader;
  private readonly listTargets: AttachedTargetLister;
  private readonly logger?: Pick<DaemonLogger, 'warn'>;

  /** Reentrancy guard: the backstop job is the sole caller, but a slow drain must
   *  not overlap the next tick's invocation (both would read the same buffers and
   *  race the high-water store; the host is idempotent, so overlap is safe but
   *  wasteful). */
  private draining = false;

  constructor(deps: EventReplayDrainDeps) {
    this.machineId = deps.machineId;
    this.store = deps.store ?? createFsReplayStore();
    this.transport = deps.transport ?? makeDefaultTransport(deps.machineId);
    this.bufferReader = deps.bufferReader ?? defaultBufferReader;
    this.listTargets = deps.listTargets ?? listAttachedReplayTargets;
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
   *  un-shipped capture. Best-effort read; never throws. */
  pendingCount(): number {
    let n = 0;
    for (const attached of this.safeTargets()) {
      for (const sessionId of this.safeSessions(attached.bufferDir)) {
        const total = this.bufferReader.readRecords(attached.bufferDir, sessionId).length;
        const acked = this.store.get(attached.hostId, sessionId)?.acked_count ?? 0;
        if (total > acked) n += 1;
      }
    }
    return n;
  }

  /** Purge a detached project's high-water entries on a host (purge-on-detach). */
  purgeProject(hostId: string, projectId: string): void {
    this.store.purgeProject(hostId, projectId);
  }

  /** Purge every high-water entry for a host (host dropped entirely). */
  purgeHost(hostId: string): void {
    this.store.purgeHost(hostId);
  }

  // --- internals ---

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
