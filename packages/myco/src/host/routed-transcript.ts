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
import { resolveRoutedTranscriptPath } from '../grove/paths.js';
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

/**
 * The append-delta body (capture-push §5.2). `bytes` is the base64 encoding of
 * the raw transcript slice `[base_offset, base_offset + len)` — base64, not a
 * plain string, so byte accounting stays exact regardless of the slice's
 * contents (the whole offset contract is byte-keyed). `agent` is optional
 * metadata carried per §5.2; the materializer does not need it (the miner
 * discovers the adapter from the session row), so it is accepted but unused here.
 */
const TranscriptChunkBody = z.object({
  machine_id: z.string().min(1),
  session_id: z.string().min(1),
  transcript_id: z.string().min(1),
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
