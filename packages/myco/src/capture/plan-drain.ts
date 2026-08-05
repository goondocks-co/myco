/**
 * Team Host — the MEMBER side of the routed plan-content companion push
 * (capture-push §5.5, plan C7). The host RECEIVE side (capturePlan against the
 * host Grove DB) is `host/routed-plan.ts`; this is the SEND side.
 *
 * Under Team Host a routed session's plan FILE lives on the member's disk, but
 * plan capture writes to the host's Grove DB. The member's proxy is byte-opaque,
 * so it cannot inject the file's content into the `/events` body — plan content
 * therefore rides its OWN companion channel (`POST /routed-capture/plan`) through
 * that host's public URL, exactly parallel to the transcript-content drain
 * (`capture/transcript-drain.ts`, C1) but SIMPLER: a plan file is small and read
 * WHOLE, so there is no byte offset — the high-water is the CONTENT HASH the host
 * last acked. A re-push of unchanged content is a member-side no-op; on the host,
 * capturePlan's logical-key upsert makes a replay idempotent regardless.
 *
 * Like C1 this is the transcript/DB-free analog of the EventBuffer
 * (`capture/buffer.ts`): a machine-scoped, filesystem-durable work-queue, NEVER a
 * Grove-DB `team_outbox` table (an attached project has no local Grove DB, §4). It
 * carries the Team-Sync drain discipline WITHOUT the D1 transport: at-least-once
 * with host-side idempotency, NO local attempt counter (a failed drain retries on
 * the next tick), NO TTL / NO cap on pending, and purge-on-detach.
 *
 * ORDERING (§5.3). The plan-triggering Stop backstop runs on the HOST when
 * `/events/stop` is forwarded, so the member flushes pending plan pushes BEFORE
 * that terminal route (the `flushBeforeForward` seam, shared route list with the
 * transcript drain) — the plan content must be present when the host mines.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_BODY_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
} from '../constants.js';
import { assertSafeCaptureSegment, resolveMemberPlanDrainDir } from '../grove/paths.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import type { GroveProjectId } from '../grove/ids.js';
import { getHostMembershipSnapshot } from '../host/registry.js';
import { hostDescriptorFor, requireProjectScopedTarget } from '../host/routing.js';
import type { RemoteTarget } from '../host/routing.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { defaultDial, hostAuthority, hostProtocolCompatible } from '../daemon/host-proxy.js';
import { isPlanWriteEvent, type PlanWatchConfig } from '../daemon/plan-capture.js';
import type { DaemonLogger } from '../daemon/logger.js';
import {
  clearDrainFailure,
  recordDrainFailure,
  summarizeDrainHealth,
  type DrainHealthCounters,
  type FailureTrackedEntry,
} from './drain-health.js';
import { readFilePresence, type Presence } from '@myco/utils/presence.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';

/** How often to repeat the "nothing dialable for these entries" warn per host.
 *  Throttled because the drain ticks continuously and the condition persists
 *  until a re-join — one line per interval, not one per tick. */
const DRAIN_UNRESOLVED_LOG_INTERVAL_MS = 10 * 60 * 1000;


/** Stable, filesystem-safe queue key for one plan file (its member-local path).
 *  Whole-file channel → keyed by path (no inode/offset like the transcript id). */
export function derivePlanRef(planPath: string): string {
  return `pl_${crypto.createHash('sha256').update(planPath).digest('hex').slice(0, 32)}`;
}

/** SHA-256 of the plan file content — the member-side dedup high-water. Purely
 *  local: it decides whether the current file differs from what the host acked, so
 *  it need not match the plan store's own content hash on the host. */
function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** One persisted work-queue entry: a plan file the member is shipping to a host,
 *  plus the host-acked content hash. Keyed `(host_id, session_id, plan_ref)`. */
export interface PlanDrainEntry extends FailureTrackedEntry {
  host_id: string;
  session_id: string;
  plan_ref: string;
  project_id: string;
  grove_id: string;
  /** Member-local absolute path to the plan file (the durable content source). */
  plan_path: string;
  /** Optional symbiont metadata (§5.5); informational — the host rediscovers the
   *  adapter from the session row. */
  agent?: string;
  /** The content hash the host last acked. null → nothing shipped yet. A re-push
   *  is skipped while the file's current hash matches this. */
  acked_hash: string | null;
  updated_at: string;
}

/** The plan companion-push wire body (`POST /routed-capture/plan`; C7 contract). */
export interface PlanChunkRequest {
  machine_id: string;
  session_id: string;
  plan_path: string;
  content: string;
  agent?: string;
}

/** The host response the member acts on. `planId` is informational; `status` 200
 *  advances the acked hash. */
export interface PlanChunkResponse {
  status: number;
  planId?: string;
}

/** The POST transport seam — the ONE side effect that leaves the machine. Tests
 *  inject a fake host; production POSTs to the host's public URL via
 *  {@link defaultPlanTransport}. */
export type PlanPostTransport = (
  target: RemoteTarget,
  body: PlanChunkRequest,
) => Promise<PlanChunkResponse>;

/** The filesystem read seam — the whole plan file, its genuine absence, or an
 *  undetermined read. An undetermined read must never be treated as absence:
 *  the entry is the only record that this plan still owes the host, and
 *  dropping it on a transient EACCES/EMFILE loses the plan permanently.
 *  Injectable so the drain's dedup/skip semantics are unit-testable without disk. */
export interface PlanFileReader {
  read(planPath: string): Presence<string>;
}

/** The durable store seam over the machine-scoped queue dir. Default is the
 *  filesystem store below; tests may inject an in-memory one. */
export interface PlanDrainStore {
  list(): PlanDrainEntry[];
  listForHost(hostId: string): PlanDrainEntry[];
  get(hostId: string, sessionId: string, planRef: string): PlanDrainEntry | null;
  put(entry: PlanDrainEntry): void;
  remove(hostId: string, sessionId: string, planRef: string): void;
  /** Purge every entry for a host (purge-on-detach when the host is dropped). */
  purgeHost(hostId: string): void;
  /** Purge a single attached project's entries on a host (purge-on-detach). */
  purgeProject(hostId: string, projectId: string): void;
}

// ---------------------------------------------------------------------------
// Default filesystem store — `<member>/plan-drain/<host>/<session>/<ref>.json`
// ---------------------------------------------------------------------------

function safeKey(hostId: string, sessionId: string, planRef: string): boolean {
  try {
    assertSafeCaptureSegment(hostId, 'host_id');
    assertSafeCaptureSegment(sessionId, 'session_id');
    assertSafeCaptureSegment(planRef, 'plan_ref');
    return true;
  } catch {
    return false;
  }
}

function entryFilePath(root: string, hostId: string, sessionId: string, planRef: string): string {
  return path.join(root, hostId, sessionId, `${planRef}.json`);
}

function readEntryFile(filePath: string): PlanDrainEntry | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PlanDrainEntry;
  } catch {
    return null;
  }
}

export function createFsPlanDrainStore(rootDir: string = resolveMemberPlanDrainDir()): PlanDrainStore {
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
      return walkFiles(rootDir).map(readEntryFile).filter((e): e is PlanDrainEntry => e !== null);
    },
    listForHost(hostId) {
      if (!safeKey(hostId, 'x', 'x')) return [];
      return walkFiles(path.join(rootDir, hostId)).map(readEntryFile).filter((e): e is PlanDrainEntry => e !== null);
    },
    get(hostId, sessionId, planRef) {
      if (!safeKey(hostId, sessionId, planRef)) return null;
      return readEntryFile(entryFilePath(rootDir, hostId, sessionId, planRef));
    },
    put(entry) {
      if (!safeKey(entry.host_id, entry.session_id, entry.plan_ref)) return;
      const filePath = entryFilePath(rootDir, entry.host_id, entry.session_id, entry.plan_ref);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    },
    remove(hostId, sessionId, planRef) {
      if (!safeKey(hostId, sessionId, planRef)) return;
      const filePath = entryFilePath(rootDir, hostId, sessionId, planRef);
      fs.rmSync(filePath, { force: true });
      // Reap a torn `.tmp` sibling left by a crash mid-put (write-then-rename)
      // — otherwise it outlives the entry it belonged to.
      fs.rmSync(`${filePath}.tmp`, { force: true });
    },
    purgeHost(hostId) {
      if (!safeKey(hostId, 'x', 'x')) return;
      fs.rmSync(path.join(rootDir, hostId), { recursive: true, force: true });
    },
    purgeProject(hostId, projectId) {
      if (!safeKey(hostId, 'x', 'x')) return;
      for (const filePath of walkFiles(path.join(rootDir, hostId))) {
        const entry = readEntryFile(filePath);
        if (entry && entry.project_id === projectId) {
          fs.rmSync(filePath, { force: true });
          fs.rmSync(`${filePath}.tmp`, { force: true }); // torn-put sibling
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default fs reader + POST transport
// ---------------------------------------------------------------------------

const defaultFileReader: PlanFileReader = {
  read(planPath) {
    return readFilePresence(planPath);
  },
};

/**
 * Production transport: POST the plan content to the host's
 * `/routed-capture/plan` through the SAME dial primitive the byte-opaque proxy
 * uses ({@link defaultDial}), attaching the host bearer + protocol-version header
 * AND the tenancy headers (project/grove/machine/session) the host resolves the
 * Grove DB from — plan capture WRITES the DB, so unlike the transcript materializer
 * the host must bind the right Grove. Reads and parses the small JSON ack.
 *
 * `target.projectId`/`target.groveId` are the tenancy of the ENTRY being shipped
 * (the drain scopes them per-entry — see `drainEntry`), NOT the batch's host
 * target; only `target.host.*` + `target.bearer` are the shared host connection.
 * This is what keeps a multi-project host-drain from misrouting one project's plan
 * into another's Grove.
 */
export const defaultPlanTransport: PlanPostTransport = async (target, body) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: hostAuthority(target),
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    // Per-entry tenancy claims (set by drainEntry) → host binds the Grove DB
    // capturePlan writes to. The host stamps its OWN local daemon bearer after the
    // overlay gate, so we send no `x-myco-auth` (the member stripped it; the host
    // re-adds it).
    [REQUEST_CONTEXT_HEADERS.projectId]: requireProjectScopedTarget(target, 'plan drain'),
    [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: body.machine_id,
    [REQUEST_CONTEXT_HEADERS.sessionId]: body.session_id,
  };
  const req = await defaultDial(target, { method: 'POST', path: '/routed-capture/plan', headers });

  return new Promise<PlanChunkResponse>((resolve, reject) => {
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
        let parsed: { plan_id?: unknown } = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* non-JSON body */ }
        resolve({
          status: res.statusCode ?? 0,
          planId: typeof parsed.plan_id === 'string' ? parsed.plan_id : undefined,
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(payload);
  });
};

/** Default host-target builder for the backstop / post-restart drain, when no live
 *  {@link RemoteTarget} is on hand. Reads the host record + bearer from the
 *  machine-global registry. */
function defaultResolveHostTarget(
  hostId: string,
  sample: PlanDrainEntry,
  lockNamespace: PerUserLockNamespace,
): RemoteTarget | null {
  const membership = getHostMembershipSnapshot(hostId, lockNamespace);
  if (!membership) return null;
  const { record, bearer } = membership;
  const host = hostDescriptorFor(record);
  // No usable address is the same answer as no membership — there is nothing
  // to dial. The entry stays pending rather than being recorded as a host
  // failure, because the host did not fail: this member has no way to reach it.
  if (!host) return null;
  return {
    projectId: sample.project_id as GroveProjectId,
    groveId: sample.grove_id,
    host,
    bearer,
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface PlanDrainDeps {
  machineId: string;
  /** The member daemon's plan watch config — the SAME predicate the local plan
   *  path uses, so member-side detection matches host-side classification. */
  planWatchConfig: PlanWatchConfig;
  store?: PlanDrainStore;
  transport?: PlanPostTransport;
  fileReader?: PlanFileReader;
  resolveHostTarget?: (hostId: string, sample: PlanDrainEntry) => RemoteTarget | null;
  lockNamespace?: PerUserLockNamespace;
  /** Coalescing throttle for the mid-turn drain — mirrors live-reconcile's 3 s
   *  leading+trailing throttle. Default 3000ms. */
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

export class PlanDrainQueue {
  private readonly machineId: string;
  private readonly planWatchConfig: PlanWatchConfig;
  private readonly store: PlanDrainStore;
  private readonly transport: PlanPostTransport;
  private readonly fileReader: PlanFileReader;
  private readonly resolveHostTarget: (hostId: string, sample: PlanDrainEntry) => RemoteTarget | null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  private readonly logger?: Pick<DaemonLogger, 'warn'>;

  private readonly throttle = new Map<string, HostThrottleState>();
  /** Per-host serialization: chains drains for one host so a throttled drain, a
   *  flush, and the backstop never POST the same entries concurrently. */
  private readonly hostChains = new Map<string, Promise<void>>();

  constructor(deps: PlanDrainDeps) {
    this.machineId = deps.machineId;
    this.planWatchConfig = deps.planWatchConfig;
    this.store = deps.store ?? createFsPlanDrainStore();
    this.transport = deps.transport ?? defaultPlanTransport;
    this.fileReader = deps.fileReader ?? defaultFileReader;
    this.resolveHostTarget = deps.resolveHostTarget
      ?? ((hostId, sample) => defaultResolveHostTarget(
        hostId,
        sample,
        deps.lockNamespace ?? nativePerUserLockNamespace,
      ));
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.logger = deps.logger;
  }

  /**
   * Enqueue trigger — called for every COLLECT event forwarded to a host. When the
   * event is a plan-dir write (the SAME `isPlanWriteEvent` predicate the local path
   * uses), ensure a queue entry exists for the plan file and schedule a throttled
   * push of its content. Best-effort: never throws into the collect path.
   *
   * Root scoping (C7, carried — fixed): `isPlanWriteEvent` resolves relative watch
   * dirs against a project root. `this.planWatchConfig.projectRoot` is bound ONCE
   * at daemon construction to the bootstrap-anchor project's root
   * (`daemon/main.ts`) — correct for a member serving only its own bootstrap
   * project, but this daemon CAN serve requests for OTHER attached projects too
   * (the same multi-tenant dispatch the skill-delete API path resolves per
   * request from `principal.tenancy.projectVaultDir` — see `daemon/api/skills.ts`).
   * `target.root` (threaded from the attach registry's `AttachRef.root` onto
   * `RemoteTarget` by `host/routing.ts` `remoteTargetFor`) carries THIS request's
   * own project root; fall back to the bootstrap anchor only when it is absent
   * (an attach record created before `root` was added to `AttachRef`).
   */
  noteCollect(target: RemoteTarget, event: Record<string, unknown>): void {
    try {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
      if (!sessionId) return;
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
      if (!toolName) return;
      const watchConfig: PlanWatchConfig = target.root
        ? { ...this.planWatchConfig, projectRoot: target.root }
        : this.planWatchConfig;
      const planPath = isPlanWriteEvent(
        toolName,
        event.tool_input as Record<string, unknown> | undefined,
        watchConfig,
      );
      if (!planPath) return;
      const agent = typeof event.agent === 'string' ? event.agent : undefined;

      const planRef = derivePlanRef(planPath);
      const existing = this.store.get(target.host.host_id, sessionId, planRef);
      this.store.put({
        host_id: target.host.host_id,
        session_id: sessionId,
        plan_ref: planRef,
        project_id: requireProjectScopedTarget(target, 'plan drain'),
        grove_id: target.groveId,
        plan_path: planPath,
        agent,
        // Keep the acked hash on a re-enqueue: an unchanged file re-note must not
        // resend. A changed file's hash won't match, so the next drain ships it.
        acked_hash: existing?.acked_hash ?? null,
        updated_at: new Date().toISOString(),
      });
      this.scheduleThrottled(target);
    } catch (err) {
      this.logger?.warn('capture.plan-drain', 'noteCollect failed', {
        host_id: target.host.host_id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * The `flushBeforeForward` seam the host proxy calls before forwarding a terminal
   * mining-trigger route (`/events/stop`, `/sessions/register`,
   * `/sessions/unregister`). Fully drains this host's pending plan pushes so the
   * content is present when the host's Stop-backstop plan reconcile fires (§5.3).
   * Awaited; never throws.
   */
  async flushBeforeForward(target: RemoteTarget): Promise<void> {
    try {
      await this.runExclusive(target.host.host_id, () => this.drainHost(target.host.host_id, target));
    } catch (err) {
      this.logger?.warn('capture.plan-drain', 'flushBeforeForward failed', {
        host_id: target.host.host_id,
        error: (err as Error).message,
      });
    }
  }

  /** Backstop drain across every host with pending entries (the JobRunner tick).
   *  The catch-up sweep for anything a throttle missed (e.g. a host unreachable at
   *  flush time). Returns processed/remaining for the runner. */
  async drainAll(): Promise<{ processed: number; remaining: number }> {
    const hostIds = new Set(this.store.list().map((e) => e.host_id));
    let processed = 0;
    for (const hostId of hostIds) {
      const res = await this.runExclusive(hostId, () => this.drainHost(hostId, null));
      processed += res.processed;
    }
    return { processed, remaining: this.pendingCount() };
  }

  /** Count plan files with un-shipped content — the deep-sleep inhibitor signal
   *  (`hold.pending`). A plan file that no longer exists is NOT pending: its content
   *  is unreachable, so it must never hold the machine awake. */
  pendingCount(): number {
    let n = 0;
    for (const entry of this.store.list()) {
      const content = this.fileReader.read(entry.plan_path);
      if (content.state === 'absent') continue; // file gone → inert
      // An undetermined read counts as pending: the entry may still owe the
      // host, and releasing the hold would let the machine sleep on unshipped work.
      if (content.state === 'unknown' || hashContent(content.value) !== entry.acked_hash) n += 1;
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
   * Session-terminal prune (consolidation Task C-2, item 3 — the plan-drain
   * equivalent of the transcript drain's `noteSessionEnded`). Called from the
   * host-proxy's `noteSessionEnded` seam right after `flushBeforeForward` has
   * drained this host for the `/sessions/unregister` route. Removes this
   * session's entries that are demonstrably unreachable-or-caught-up:
   *  - the plan file is gone (mirrors `drainEntry`'s existing missing-file
   *    prune — content unreachable, nothing to ship), or
   *  - unchanged since the last ack (`hashContent(content) === acked_hash`).
   * An entry the flush could NOT catch up (transport still failing) is left
   * completely alone — prune-only-acked; the backstop drain keeps retrying
   * it regardless of session end.
   */
  noteSessionEnded(hostId: string, sessionId: string): void {
    try {
      for (const entry of this.store.listForHost(hostId)) {
        if (entry.session_id !== sessionId) continue;
        const content = this.fileReader.read(entry.plan_path);
        if (content.state === 'unknown') continue; // undetermined — keep the entry for a later tick
        if (content.state === 'absent' || hashContent(content.value) === entry.acked_hash) {
          this.store.remove(entry.host_id, entry.session_id, entry.plan_ref);
        }
      }
    } catch (err) {
      this.logger?.warn('capture.plan-drain', 'noteSessionEnded failed', {
        host_id: hostId,
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  }

  /** The deps object both dispatch chokepoints thread into `handleAttachedRequest`:
   *  the flush-before-terminal-route seam, the collect enqueue trigger, and the
   *  session-terminal prune trigger. */
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
      void this.runExclusive(hostId, () => this.drainHost(hostId, t)).catch(() => { /* logged in drainEntry */ });
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
    this.hostChains.set(hostId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async drainHost(
    hostId: string,
    target: RemoteTarget | null,
  ): Promise<{ processed: number; remaining: number }> {
    const entries = this.store.listForHost(hostId);
    if (entries.length === 0) return { processed: 0, remaining: 0 };

    const t = target ?? this.resolveHostTarget(hostId, entries[0]);
    if (!t) {
      // No membership, or a membership with no usable address. Either way there
      // is nothing to dial and the entries stay PENDING — never dropped. Said
      // out loud (throttled) because silence here was indistinguishable from a
      // drain that had nothing to do, while the sibling version-skew case below
      // has always warned.
      if (shouldLogOncePerInterval(`drain.unresolved:${hostId}`, DRAIN_UNRESOLVED_LOG_INTERVAL_MS)) {
        this.logger?.warn('capture.plan-drain', 'no dialable host for pending entries — they stay queued', {
          host_id: hostId,
          pending: entries.length,
        });
      }
      return { processed: 0, remaining: entries.length };
    }

    // A version-incompatible host never self-heals by retry — skip (entries stay
    // pending; the drain re-checks after an upgrade + reconnect).
    if (!hostProtocolCompatible(t.host.protocol_version)) {
      this.logger?.warn('capture.plan-drain', 'host protocol incompatible — drain skipped', {
        host_id: hostId,
        host_protocol: t.host.protocol_version,
      });
      return { processed: 0, remaining: entries.length };
    }

    let processed = 0;
    for (const entry of entries) {
      processed += await this.drainEntry(t, entry);
    }
    return { processed, remaining: this.pendingCount() };
  }

  /**
   * Ship one plan file's current content to the host, iff it changed since the last
   * ack. Reads the whole file, dedups by content hash, POSTs, and records the new
   * hash on a 200 (at-least-once; a failed POST leaves the hash unadvanced and
   * retries next tick — prune-only-acked). Returns 1 if a POST was made.
   *
   * `hostTarget` carries only the HOST CONNECTION + bearer (shared by every entry
   * on this host); the request's TENANCY is taken PER-ENTRY below.
   */
  private async drainEntry(hostTarget: RemoteTarget, entry: PlanDrainEntry): Promise<number> {
    const read = this.fileReader.read(entry.plan_path);
    if (read.state === 'absent') {
      // The plan file was removed/moved after the write — its content is
      // unreachable. Remove the inert entry (bounds the store; nothing to ship).
      this.store.remove(entry.host_id, entry.session_id, entry.plan_ref);
      return 0;
    }
    if (read.state === 'unknown') {
      this.logger?.warn('capture.plan-drain', 'plan file unreadable — retry next tick', {
        host_id: entry.host_id,
        session_id: entry.session_id,
        error: read.error.message,
      });
      // The file may still be there and unshipped; keep the entry and retry.
      recordDrainFailure(entry, 'unreadable', new Date().toISOString());
      this.store.put(entry);
      return 0;
    }
    const content = read.value;
    const hash = hashContent(content);
    if (hash === entry.acked_hash) return this.noOpDrained(entry); // unchanged since last ack — no-op

    // CROSS-TENANT SAFETY (the load-bearing invariant): one host-drain batches
    // entries from EVERY project attached to this host, but `capturePlan` WRITES the
    // Grove the tenancy headers bind. So each POST must carry its OWN entry's
    // project/grove, NEVER the arbitrary project the batch's `hostTarget` happened
    // to be resolved from — otherwise project B's plan lands in project A's Grove.
    // Scope the transport target per-entry: host connection + bearer from
    // `hostTarget`, tenancy (`projectId`/`groveId`) from the entry. Only the tenancy
    // HEADERS read these fields; `defaultDial` reads solely `target.host.*`.
    const target: RemoteTarget = {
      ...hostTarget,
      projectId: entry.project_id as GroveProjectId,
      groveId: entry.grove_id,
    };

    let resp: PlanChunkResponse;
    try {
      resp = await this.transport(target, {
        machine_id: this.machineId,
        session_id: entry.session_id,
        plan_path: entry.plan_path,
        content,
        agent: entry.agent,
      });
    } catch (err) {
      this.logger?.warn('capture.plan-drain', 'plan POST failed — retry next tick', {
        host_id: entry.host_id,
        session_id: entry.session_id,
        error: (err as Error).message,
      });
      // Transport-level failure — the host itself could not be reached.
      recordDrainFailure(entry, 'unreachable', new Date().toISOString());
      this.store.put(entry);
      return 0; // leave acked_hash unchanged (prune-only-acked); retry next tick
    }

    if (resp.status === 200) {
      entry.acked_hash = hash;
      entry.updated_at = new Date().toISOString();
      clearDrainFailure(entry);
      this.store.put(entry);
    } else {
      this.logger?.warn('capture.plan-drain', 'unexpected host response — retry next tick', {
        host_id: entry.host_id,
        session_id: entry.session_id,
        status: resp.status,
      });
      // The host was reachable (it answered) but rejected the push.
      recordDrainFailure(entry, 'rejected', new Date().toISOString());
      this.store.put(entry);
    }
    return 1;
  }

  /** Clear a stale failure recorded on a PAST attempt before returning from
   *  the "unchanged since last ack" no-op pass — not a live transport
   *  attempt, so it can't itself confirm the host is still unreachable.
   *  Skips the store write when the entry has no failure on record, so the
   *  common healthy-entry path costs nothing extra. */
  private noOpDrained(entry: PlanDrainEntry): number {
    if ((entry.consecutive_failures ?? 0) > 0 || entry.last_error_kind) {
      clearDrainFailure(entry);
      this.store.put(entry);
    }
    return 0;
  }

  /** Per-host drain health (consolidation Task C-5): un-shipped entries/bytes,
   *  host-unreachable occurrences, and failing-entry counts, derived from the
   *  SAME persisted queue state `drainAll`/`pendingCount` read — no new store,
   *  no network call. */
  health(): Map<string, DrainHealthCounters> {
    const rows = this.store.list().map((entry) => {
      const content = this.fileReader.read(entry.plan_path);
      // Mirrors pendingCount: an undetermined read stays pending so a failing
      // entry cannot read as healthy in the surface built to catch it.
      const pending = content.state === 'unknown'
        || (content.state === 'present' && hashContent(content.value) !== entry.acked_hash);
      return {
        host_id: entry.host_id,
        pending,
        pendingUnits: pending && content.state === 'present'
          ? Buffer.byteLength(content.value, 'utf-8')
          : undefined,
        consecutive_failures: entry.consecutive_failures,
        last_error_kind: entry.last_error_kind,
      };
    });
    return summarizeDrainHealth(rows);
  }
}

/** Build the member plan-content drain queue (capture-push §5.5, C7). */
export function createPlanDrainQueue(deps: PlanDrainDeps): PlanDrainQueue {
  return new PlanDrainQueue(deps);
}
