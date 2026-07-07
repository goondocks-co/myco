import { sha256Hex } from '@myco/canopy/hash.js';

/**
 * Private ownership/fingerprint manifest for the OKF bundle — one entry per
 * Myco-published page, recording the sha256 of the content Myco last wrote
 * there. This is what lets a later read tell "Myco published this page and
 * it's unchanged" apart from "a human hand-edited a Myco-published page" (the
 * latter is what Task 3.2's refine-not-clobber logic needs `isHandEdited` for).
 *
 * `bundleGeneration` mirrors `OkfPrivateManifest.bundle_generation` — the
 * generation these fingerprints reflect. It exists so crash-recovery can tell
 * "the ownership write for this generation never landed" (safe to recompute
 * from the on-disk tree) apart from "ownership is caught up, and a page now
 * differs because a human edited it" (must NOT be silently overwritten —
 * that would erase the very signal this file exists to preserve).
 */
export interface OkfOwnership {
  bundleGeneration: number;
  pages: Record<string, { fingerprint: string; generatedAt: string }>;
}

/**
 * The narrow ProjectVault surface {@link readOwnership}/{@link writeOwnership}
 * delegate to. Declared here (rather than importing ProjectVault) so this
 * model layer stays dependency-light — a ProjectVault satisfies it
 * structurally. Mirrors `synthesis/plan.ts`'s `PlanVault`.
 */
export interface OwnershipVault {
  writeOkfOwnership(ownership: OkfOwnership): void;
  readOkfOwnership(): OkfOwnership | null;
}

/** PURE READ: null on a missing or corrupt ownership file. Mirrors {@link writeOwnership}. */
export function readOwnership(vault: OwnershipVault): OkfOwnership | null {
  return vault.readOkfOwnership();
}

/** Durably persist the ownership manifest (atomic, gitignore-first). Mirrors {@link readOwnership}. */
export function writeOwnership(vault: OwnershipVault, ownership: OkfOwnership): void {
  vault.writeOkfOwnership(ownership);
}

/**
 * True when `currentContent` at `pagePath` no longer matches the fingerprint
 * Myco recorded at publish — i.e. a human edited a page Myco published. A
 * page absent from `ownership` (never published by Myco, or no ownership file
 * at all) isn't "hand-edited" in the tracked sense: false.
 */
export function isHandEdited(pagePath: string, currentContent: string, ownership: OkfOwnership | null): boolean {
  const entry = ownership?.pages[pagePath];
  if (!entry) return false;
  return sha256Hex(currentContent) !== entry.fingerprint;
}
