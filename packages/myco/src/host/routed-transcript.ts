/**
 * Team Host — the host RECEIVE side of routed transcript capture (capture-push
 * §5.2/§5.3, plan C2 + C3).
 *
 * Under Team Host a routed session's transcript file lives on the MEMBER's disk,
 * but the miner runs on the HOST (where the Grove DB is). The member drains the
 * transcript's append-only bytes to the host; this module is what the host does
 * with them: it derives the stable per-transcript id both sides key on (C3),
 * and materializes the pushed byte-deltas into a host-local `.jsonl` the miner
 * reads unchanged (C2).
 *
 * The wire is an opaque, offset-keyed, append-only byte log — the SAME
 * offset/inode/fingerprint discipline the miner already uses internally
 * (`capture/transcript-miner.ts`), lifted to the network:
 *
 *   - the host is the offset authority; every append is gated on
 *     `base_offset === current_size`, so the channel is idempotent by offset
 *     and needs no row-op schema (capture-push §4/§5.2);
 *   - a re-POST of already-present bytes (`base_offset < current_size`) is a
 *     no-op that returns the current size (idempotent replay);
 *   - a gap (`base_offset > current_size`) is refused with the current size so
 *     the member resends from there.
 *
 * All line-boundary / chunk-cap semantics live in the MEMBER drain (C1) and the
 * MINER (consume) — the host is byte-agnostic: it appends whatever byte range the
 * member sends at the expected offset, and keeps no line-awareness of its own.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { withFileLockSync } from '../utils/lifecycle-lock.js';
import {
  assertSafeCaptureSegment,
  isSafeCaptureSegment,
  resolveRoutedTranscriptPath,
  resolveRoutedTranscriptsDir,
} from '../grove/paths.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';

/**
 * Per-POST byte cap the MEMBER drain (C1) splits at, exported as the shared
 * contract. ~1.5 MB of RAW transcript bytes — one order below the daemon's 8 MB
 * request-body limit even after base64 inflation (~2 MB) plus JSON envelope, and
 * generous for JSONL turns (capture-push §5.2 "bound every single push"). The
 * host does not enforce it (readBody's 8 MB limit is the hard backstop); it lives
 * here so producer and the body limit stay reconcilable in one place.
 */
export const MAX_TRANSCRIPT_PUSH_BYTES = 1_500_000;

/** What the offset gate decided for one chunk against the file's current size. */
export type ChunkAction = 'append' | 'replay' | 'gap';

/**
 * The pure offset gate (capture-push §5.2). Given the file's current byte size,
 * the chunk's declared `baseOffset`, and its length, decide whether to append,
 * treat as an already-present replay, or refuse as a gap. No I/O — unit-testable
 * in isolation; the store below calls it inside its per-file lock so the decision
 * and the append are atomic.
 */
export function decideChunkAction(currentSize: number, baseOffset: number): ChunkAction {
  if (baseOffset === currentSize) return 'append';
  if (baseOffset < currentSize) return 'replay';
  return 'gap';
}

/** The result of one materialization attempt. `size` is ALWAYS the host's
 *  post-attempt authoritative byte size, which the member records as its
 *  high-water sent offset (and resumes from on `accepted: false`). */
export interface MaterializeResult {
  /** True when the bytes are now durably present (fresh append OR already-present
   *  replay); false only for a gap (member must resend from `size`). */
  accepted: boolean;
  action: ChunkAction;
  /** Post-attempt authoritative size of the materialized file, in bytes. */
  size: number;
}

/**
 * The fs seam the materializer writes through. `appendAtOffset` MUST perform the
 * size-read + gate + append atomically (the default impl holds a per-file lock),
 * so two concurrent pushes for one transcript can never both pass the
 * `base_offset === current_size` gate. Injectable so tests exercise the offset
 * semantics without real disk.
 */
export interface RoutedTranscriptStore {
  appendAtOffset(machineId: string, sessionId: string, transcriptId: string, baseOffset: number, bytes: Buffer): MaterializeResult;
}

/**
 * Default store: appends under the host control home
 * (`~/.myco-team/host/routed-transcripts/<machine>/<session>/<tid>.jsonl`,
 * {@link resolveRoutedTranscriptPath}). Synchronous + flock-serialized, mirroring
 * the EventBuffer's append discipline (`capture/buffer.ts`). Tests point
 * `MYCO_TEAM_HOME` at a tmpdir for hermetic disk; the {@link RoutedTranscriptStore}
 * interface is the seam for disk-free unit tests.
 */
export function createFsRoutedTranscriptStore(): RoutedTranscriptStore {
  return {
    appendAtOffset(machineId, sessionId, transcriptId, baseOffset, bytes): MaterializeResult {
      const filePath = resolveRoutedTranscriptPath(machineId, sessionId, transcriptId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lockPath = `${filePath}.lock`;
      return withFileLockSync(lockPath, () => {
        const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        const action = decideChunkAction(currentSize, baseOffset);
        if (action === 'append') {
          fs.appendFileSync(filePath, bytes);
          return { accepted: true, action, size: currentSize + bytes.length };
        }
        // replay (bytes already present) or gap (member is ahead) — never write;
        // return the authoritative size so the member re-slices from it.
        return { accepted: action === 'replay', action, size: currentSize };
      });
    },
  };
}

/**
 * Derive the stable transcript id both the member drain and the host key on
 * (capture-push §5.2, plan C3). A hash of the MEMBER-local transcript path,
 * namespaced by `machine_id` and salted with the file's inode so a NEW id is
 * minted on inode change (rotation) — mirroring the miner's own inode-based
 * rotation detection (`capture/transcript-miner.ts` parseAllEvents). Namespacing
 * by `machine_id` prevents cross-member path/inode collisions (inode numbers are
 * only unique per device per machine) and keeps the host miner's per-path parse
 * cache correct. Pure and deterministic; the `tx_` + hex output is a
 * filesystem-safe path segment by construction.
 */
export function deriveTranscriptId(input: {
  machineId: string;
  transcriptPath: string;
  inode: number | bigint;
}): string {
  const h = crypto.createHash('sha256');
  h.update(input.machineId);
  h.update('\0');
  h.update(input.transcriptPath);
  h.update('\0');
  h.update(String(input.inode));
  return `tx_${h.digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Host ingest route — POST /routed-capture/transcript
// ---------------------------------------------------------------------------

/** A wire-supplied id destined for a materialized-path segment: rejects
 *  anything {@link isSafeCaptureSegment} would reject, so a traversal-shaped
 *  `machine_id`/`session_id`/`transcript_id` fails schema validation up front
 *  instead of only being caught deeper by {@link assertSafeCaptureSegment}
 *  inside path resolution (see `grove/paths.ts#resolveRoutedTranscriptPath`). */
const captureSegmentField = (kind: string) => z.string().min(1).refine(
  isSafeCaptureSegment,
  { message: `Unsafe ${kind} path segment` },
);

/**
 * The append-delta body (capture-push §5.2). `bytes` is the base64 encoding of
 * the raw transcript slice `[base_offset, base_offset + len)` — base64, not a
 * plain string, so byte accounting stays exact regardless of the slice's
 * contents (the whole offset contract is byte-keyed). `agent` is optional
 * metadata carried per §5.2; the materializer does not need it (the miner
 * discovers the adapter from the session row), so it is accepted but unused here.
 */
const TranscriptChunkBody = z.object({
  machine_id: captureSegmentField('machine_id'),
  session_id: captureSegmentField('session_id'),
  transcript_id: captureSegmentField('transcript_id'),
  agent: z.string().optional(),
  base_offset: z.number().int().nonnegative(),
  bytes: z.string(),
});

/**
 * Build the `POST /routed-capture/transcript` handler. Rides the overlay gate
 * (bearer + version + stamp) via normal route registration — this factory does
 * NOT re-implement auth. The route is stamped `collect` in `host/routing.ts`
 * `ROUTE_RULES`, so `overlayHostStampRefusal` serves it locally on the host.
 *
 * `store` is injectable for tests; production uses the fs store.
 */
export function createRoutedTranscriptHandler(
  store: RoutedTranscriptStore = createFsRoutedTranscriptStore(),
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const parsed = TranscriptChunkBody.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: 'invalid_body', detail: parsed.error.issues } };
    }
    const { machine_id, session_id, transcript_id, base_offset, bytes } = parsed.data;

    const chunk = Buffer.from(bytes, 'base64');

    let result: MaterializeResult;
    try {
      result = store.appendAtOffset(machine_id, session_id, transcript_id, base_offset, chunk);
    } catch (err) {
      // Thrown only by the safe-segment guard on a traversal-shaped id — refuse
      // rather than 500, so a malformed key is a clean client error.
      return { status: 400, body: { ok: false, error: 'invalid_key', message: (err as Error).message } };
    }

    if (result.action === 'gap') {
      // The member is ahead of the host's file (host restart / GC / never got the
      // earlier bytes). Refuse with the authoritative size so it resends from there.
      return { status: 409, body: { ok: false, error: 'offset_gap', action: result.action, size: result.size } };
    }
    // append or replay — both leave the requested bytes durably present.
    return { status: 200, body: { ok: true, action: result.action, size: result.size } };
  };
}

// ---------------------------------------------------------------------------
// C4 — host-side transcript_path substitution
// ---------------------------------------------------------------------------

/**
 * Resolve the CURRENT host-materialized transcript file for a routed session
 * (plan C4). C2 appends the member's pushed bytes to
 * `<routed-transcripts>/<machine>/<session>/<tid>.jsonl`; `<tid>` rotates on the
 * member file's inode change (C3), so a session dir may hold several sibling
 * files. The live one is the MOST-RECENTLY-MODIFIED: rotation appends a fresh
 * sibling and only the live file keeps growing (a replay is a no-op that never
 * writes — see {@link createFsRoutedTranscriptStore} — so it cannot bump an old
 * file's mtime). Returns null when nothing is materialized yet (dir missing or no
 * `.jsonl`), so the caller degrades rather than resolve a path that does not
 * exist on this host.
 *
 * The `<machine>/<session>` segments are wire-supplied (tenancy header + event
 * body); they funnel through {@link assertSafeCaptureSegment} (a malformed id
 * resolves to null, never an escaped path) — defense in depth alongside the
 * materializer's own guard.
 */
export function resolveRoutedTranscriptPathForSession(
  machineId: string,
  sessionId: string,
): string | null {
  let dir: string;
  try {
    dir = path.join(
      resolveRoutedTranscriptsDir(),
      assertSafeCaptureSegment(machineId, 'machine_id'),
      assertSafeCaptureSegment(sessionId, 'session_id'),
    );
  } catch {
    return null; // hostile/malformed id — never resolve a path
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // session dir absent — bytes not drained yet
  }
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs };
  }
  return newest?.filePath ?? null;
}

/** The outcome of a C4 substitution attempt (see {@link hostSubstitutedTranscriptPath}). */
export type TranscriptSubstitutionAction = 'unchanged' | 'substituted' | 'degraded-missing';

export interface TranscriptSubstitution {
  /**
   * The path the host should mine/stamp: the member path UNCHANGED for a local
   * request or an event with no path; the host-materialized file for a routed
   * request; `undefined` when the request is routed but nothing is materialized
   * yet (degrade — the caller must NOT stamp/mine the bogus member path).
   */
  transcriptPath: string | undefined;
  action: TranscriptSubstitutionAction;
}

/**
 * Host-side `transcript_path` substitution for routed capture (plan C4,
 * capture-push §5.3). A routed session's transcript lives on the MEMBER's disk,
 * so the member-local `transcript_path` in a proxied capture event does not exist
 * on the HOST; left unrewritten the host miner — and the DB-fed SessionEnd trigger
 * that later reads the stamped session row — would open a missing file. For a
 * request that is host-served for a member (`hostServed`, the B1 overlay-origin
 * signal), resolve `(machineId, sessionId)` → the file C2 materialized and return
 * it in place of the member path.
 *
 * A local (non-host-served) request, or an event that carried no path, is returned
 * UNTOUCHED — member paths on a local daemon are correct, and over-substitution
 * must never invent a path where the event had none. When host-served but nothing
 * is materialized yet (bytes not drained), return `degraded-missing` with NO path:
 * the ordering guarantee (C1 flushes before the terminal mining routes) makes this
 * rare, and replay / re-enrich (C6) recovers it — far better than stamping a member
 * path the host can never open.
 *
 * `machineId` is the MEMBER's id, carried verbatim on the proxied request's
 * `x-myco-machine-id` tenancy header (the same id the C1 drain keys the
 * materialized tree on); `sessionId` is the event's session id.
 */
export function hostSubstitutedTranscriptPath(params: {
  hostServed: boolean;
  machineId: string | undefined;
  sessionId: string;
  memberTranscriptPath: string | undefined;
}): TranscriptSubstitution {
  const { hostServed, machineId, sessionId, memberTranscriptPath } = params;
  if (!hostServed || !memberTranscriptPath) {
    return { transcriptPath: memberTranscriptPath, action: 'unchanged' };
  }
  const hostPath = machineId
    ? resolveRoutedTranscriptPathForSession(machineId, sessionId)
    : null;
  if (hostPath) return { transcriptPath: hostPath, action: 'substituted' };
  return { transcriptPath: undefined, action: 'degraded-missing' };
}

// ---------------------------------------------------------------------------
// Consolidation Task C-1 — routed-transcripts cache GC
// ---------------------------------------------------------------------------

/** One materialized `<machine_id>/<session_id>` cache directory found under
 *  the routed-transcripts root — a GC candidate for {@link listRoutedTranscriptSessionDirs}. */
export interface RoutedTranscriptSessionDir {
  machineId: string;
  sessionId: string;
  dirPath: string;
}

/**
 * Enumerate every materialized `<machine_id>/<session_id>` directory under
 * the routed-transcripts cache root (consolidation Task C-1). The GC power
 * job (`daemon/power-jobs.ts`) walks this list once per tick and resolves
 * each session's terminal status against the Grove DBs this daemon serves,
 * pruning a tree ONLY when its session is confirmed `status = 'completed'`
 * (fully mined + session-terminal — never age-based, unlike the sibling
 * `routed_event_dedup` prune).
 *
 * A malformed path segment (fails {@link assertSafeCaptureSegment}) is
 * skipped — it cannot be a directory the materializer itself wrote, since
 * every write funnels through the same guard ({@link createFsRoutedTranscriptStore}),
 * so treating it as inert here is safe. Returns an empty list when the cache
 * root does not exist yet (nothing has been routed through this host).
 */
export function listRoutedTranscriptSessionDirs(): RoutedTranscriptSessionDir[] {
  const root = resolveRoutedTranscriptsDir();
  const out: RoutedTranscriptSessionDir[] = [];
  let machineEntries: fs.Dirent[];
  try {
    machineEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const machineEntry of machineEntries) {
    if (!machineEntry.isDirectory()) continue;
    let machineId: string;
    try {
      machineId = assertSafeCaptureSegment(machineEntry.name, 'machine_id');
    } catch {
      continue;
    }
    const machineDir = path.join(root, machineEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(machineDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      let sessionId: string;
      try {
        sessionId = assertSafeCaptureSegment(sessionEntry.name, 'session_id');
      } catch {
        continue;
      }
      out.push({ machineId, sessionId, dirPath: path.join(machineDir, sessionEntry.name) });
    }
  }
  return out;
}

/**
 * Newest write timestamp (ms) under one materialized session directory —
 * the GC's append-quiescence signal. Considers every direct child file
 * (`.jsonl` transcripts, their `.lock` companions) AND the directory's own
 * mtime (bumped by entry creation, i.e. a post-completion ROTATION landing a
 * brand-new `<tid>.jsonl` the file scan alone could race). Returns null when
 * the directory is unreadable — the caller treats that as "not provably
 * quiet" and keeps the tree.
 *
 * This exists because the ingest route above appends purely by offset and
 * never touches the sessions row: bytes can land AFTER the session
 * completed (a reconnecting member's drain backstop pushing a crashed
 * session's tail), so session status alone cannot prove the tree is done
 * growing — only observed write-quiescence can.
 */
export function newestRoutedTranscriptMtimeMs(dirPath: string): number | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  try {
    newest = fs.statSync(dirPath).mtimeMs;
  } catch {
    /* dir stat raced a removal — file scan below may still resolve */
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const mtimeMs = fs.statSync(path.join(dirPath, entry.name)).mtimeMs;
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      /* file vanished mid-scan — skip */
    }
  }
  return newest;
}

/**
 * Delete one confirmed-terminal session's materialized transcript tree
 * (every sibling `.jsonl`, including inert rotated files — C3). Best-effort:
 * a concurrent removal or transient fs error never throws into the GC job's
 * per-Grove loop.
 */
export function pruneRoutedTranscriptSessionDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    /* best-effort — GC retries next tick */
  }
}
