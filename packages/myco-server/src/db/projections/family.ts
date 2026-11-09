import type { BlobStore, RelationalStore } from '../../core/adapters.js';
import type { Bound } from '../index.js';

/** The rows a phase walks in key order, up to the frontier captured when it starts. */
export interface PhaseSource {
  readonly table: string;
  readonly columns: readonly string[];
  readonly where?: string;
  readonly pageSize?: number;
  readonly startKey?: readonly (string | number)[];
  /** Every key is unique, so a page stops at its limit instead of sorting the whole range. */
  readonly unique?: boolean;
}

/** One statement of a page's reconcile: bound to the page's JSON keys, or to those keys and the instant the page runs. */
type PageStatement = { bind(keys: string): Bound } | { bindAt(keys: string, now: number): Bound };

export interface PageContext {
  readonly db: RelationalStore;
  readonly blobs: BlobStore | undefined;
  readonly keys: readonly (readonly unknown[])[];
  readonly charge: (calls: number) => void;
  readonly generation: number;
  readonly now: number;
}

export interface PagePlan {
  readonly statements: readonly Bound[];
  readonly complete: boolean;
  /** Statements to commit in place of the page when `error` is one the phase records instead of retrying. */
  readonly recover?: (error: unknown) => readonly Bound[] | undefined;
}

/** A page's cursor as read in its frontier commit. */
export interface HeldCursor {
  readonly after_key: string;
  readonly generation: number;
}

export interface CatchupPhase {
  readonly source: PhaseSource;
  readonly reconcile: readonly PageStatement[];
  /** Asserted in the frontier commit, so a phase cannot start before the phases it reads have finished. */
  readonly frontier?: () => readonly Bound[];
  /** Asserted at the head of the page's commit against the cursor the page read. */
  readonly guards?: (held: HeldCursor) => readonly Bound[];
  /** Work beyond the reconcile statements, planned before the page's commit. */
  readonly page?: (context: PageContext) => Promise<PagePlan>;
}

/** One projection's catch-up: `catchup.ts` lists these and derives everything else from them. */
export interface CatchupFamily {
  readonly projection: string;
  readonly phases: Readonly<Record<string, CatchupPhase>>;
  /** Committed with every restart of catch-up, for derived state a replay does not overwrite. */
  readonly reset?: () => readonly Bound[];
}

/** Every phase the family registers has finished. A phase row not yet seeded is not finished. */
export const everyPhaseDone = (family: CatchupFamily, phases: readonly { phase: string; done: number }[]): boolean => {
  const expected = Object.keys(family.phases);
  return phases.length === expected.length && expected.every(phase => phases.some(row => row.phase === phase && row.done === 1));
};
