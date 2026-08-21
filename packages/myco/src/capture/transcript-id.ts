/**
 * The stable transcript id every transcript producer and consumer keys on.
 *
 * A leaf: `node:crypto` only. Both the Team-Host path (`host/routed-transcript.ts`,
 * `capture/transcript-drain.ts`) and the 2.0 member import this one function —
 * the id is never re-derived "with the same inputs" anywhere else.
 */
import crypto from 'node:crypto';

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
