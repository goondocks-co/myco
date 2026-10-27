export const SESSION_VIEW_STATES = [
  'legacy-live',
  'converting',
  'current',
  'stale',
  'building',
  'catching-up',
  'failed',
  'unrebuildable',
  'frozen-tail',
  'incompatible',
] as const;
export type SessionViewState = (typeof SESSION_VIEW_STATES)[number];
export type ViewWorkStatus =
  | { state: 'unavailable'; reason: string }
  | {
      state: 'measured';
      observedAt: number;
      store: 'native' | 'remote';
      profile: 'serial' | 'parallel';
      initialBytes: number;
      offeredBytes: number;
      usefulBytes: number;
      publishedBytes: number;
      netBytes: number;
      elapsedMs: number;
      serviceMs: number;
      wakeMs: number;
      wakes: number;
      statements: number;
      roundTrips: number;
      blobCalls: number;
      rowsRead: null;
      rowsWritten: null;
      netBytesPerSecond: number;
    };
export interface SessionViewStatus {
  observedAt: number;
  counts: Record<SessionViewState, number>;
  details: { limit: number; total: number; complete: boolean };
  states: {
    project_id: string;
    session_id: string;
    title: string | null;
    state: SessionViewState;
    bytes_behind: number;
    next_attempt_at: number | null;
    last_failure: string | null;
    service_ms: number | null;
    build_bytes_behind: number | null;
    last_refusal: string | null;
    work: ViewWorkStatus;
  }[];
  cleanup: { retired: number; abandoned: number; eligibleRetired: number; heldRetired: number };
  findings: { kind: string; count: number }[];
  unplaced: { state: 'unavailable'; reason: string };
  coverageNotCarried: { state: 'unavailable'; reason: string };
  throughput:
    | { state: 'unavailable'; reason: string }
    | { state: 'measured'; admit: boolean; net?: number; days?: number | null; binding_constraint: string };
  preflight: { state: 'available'; scope: 'owner' };
}
/** The Deployment-wide batch that builds every session's view once. */
export interface ViewCutoverStatus {
  classified: boolean;
  swept: boolean;
  built: number;
  remaining: number;
  frozenTails: number;
  frozenCopying: number;
  paused: string | null;
  databaseBytes: number | null;
}
