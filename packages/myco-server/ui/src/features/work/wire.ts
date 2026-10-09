import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { RecordedIdentity, CostProvenance } from '@goondocks/myco-shared/worker-usage';
import type { StepKind, StepOutcome, UnrecognizedCount } from '@goondocks/myco-shared/worker-steps';

export type RunCallPage = RunDetailAnswer['toolCallCoverage'] & { rows: RunDetailAnswer['toolCalls'] };

/**
 * The shapes Myco's work reads off the wire beyond `/api/work` (whose shapes
 * live in `features/today/wire.ts`): a page of a project's runs, one run with
 * what it read and produced, the answers to starting a task, and a project's
 * capabilities.
 *
 * The server's own declarations (`read/runs.ts`, `read/run-reads.ts`,
 * `api/harness.ts`) pull in the server's runtime modules, which this
 * dashboard's build does not carry, so the shapes are declared here and held to
 * the server's by `tests/myco-server/work-wire.test.ts`, which the tests
 * typecheck compiles. This file imports only shared accounting types, so that check can read it
 * outside the dashboard.
 */

/**
 * The machine a run ran on: its credential, the machine that credential
 * names, the machine's name, and the member whose machine it is. The server
 * names a machine only to the member it belongs to; to anyone else
 * `machineName` is null and the run reads as that member's.
 */
export interface RunWorker {
  credentialId: string;
  machineId: string | null;
  machineName: string | null;
  /** The member the machine belongs to, served to every viewer; Myco's own runtime is named Myco. Null where the server holds none. */
  member: { id: string; label: string | null } | null;
  /** The runner that ran it, by the name every member may read; null for a member's machine. */
  runner: { id: string; name: string | null } | null;
}

/** The fields Myco's work reads of a run, on a page of the list and on its detail. */
export interface RunFields {
  fleetWait?: { reason: import('@goondocks/myco-shared/runner-fleet').QueueReason; observedAt: number };
  requested: ExecutionProfile | null;
  result: 'produced' | 'unchanged' | 'failed' | 'failed_with_output' | null;
  identity: RecordedIdentity;
  costProvenance: CostProvenance | null;
  provider: string | null;

  id: string;
  agentId: string;
  task: string | null;
  status: string;
  model: string | null;
  startedAt: number | null;
  completedAt: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  costSource: string | null;
  failed: boolean;
  queuedAt: number | null;
  heldBy: string | null;
  position: number | null;
  replaced: boolean;
  replaces: string | null;
  harness: string | null;
  worker: RunWorker | null;
  /** The member who started it by hand, `clock` or `backfill` when Myco started it on its own, null where the run names no one. */
  startedBy: string | null;
  /** The session the run's dispatch named, as a titling run's; null otherwise. */
  targetSessionId: string | null;
  /** The classifier for why a run was skipped. */
  skipReasonCode?: string | null;
  /** Why a skipped run did not run; null for any other run. */
  skipReason: string | null;
}

/** What a listed run came to: the spores it wrote and the sessions it read, as its detail counts them. */
export interface RunOutcomeCounts {
  spores: number;
  sessions: number;
  /** False when the run recorded no reads: `sessions` then counts the sessions it worked from, and 0 means no record, not "read nothing". */
  readsRecorded: boolean;
}

/** A run on a page of `GET /api/projects/{p}/runs`. */
export interface RunPageRow extends RunFields {
  outcome: RunOutcomeCounts;
}

/** A page of `GET /api/projects/{p}/runs`. */
export interface RunPage {
  readonly rows: readonly RunPageRow[];
  readonly cursor: string | null;
}

/** The fields the run panel reads of a run's detail. */
export interface RunDetailFields extends RunFields {
  canCancel: boolean;
  cancelReason: string | null;
  instruction: string | null;
  instructions: string | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  errorCode?: string | null;
  /** Why the run failed in the reader's words, where the worker that ran it gave one. */
  errorReason?: string | null;
  error: string | null;
}

/** A failure the agent's account names, and how it recovered; an empty recovery is none given. */
export interface RunAuditFailure {
  what: string;
  recovery: string;
}

/** The agent's own account of a pass, as its report carried it: commands and files kept in their shaped forms. */
export interface RunAudit {
  steps: string[];
  examined: string[];
  commands: string[];
  failures: RunAuditFailure[];
  reasoning: string;
  /** How many entries past their list's bound were cut. */
  omitted: number;
}

/** One report a run filed. */
export interface RunReport {
  action: string;
  summary: string;
  details: string | null;
  /** The agent's account of the pass the report closes; null where the report carries none. */
  audit: RunAudit | null;
  createdAt: number;
}

/** One claim of a run, and what its worker's step log holds; `steps` is null where no page of the log has arrived. */
export interface RunAttempt {
  attemptId: string;
  claimedAt: number;
  /** Who took the attempt: a runner by name, or the member whose worker credential claimed it. */
  executor: { kind: 'runner'; runnerId: string; name: string | null } | { kind: 'legacy-worker'; memberId: string | null };
  steps: { total: number; received: number; overflow: number; unrecognized: UnrecognizedCount | null } | null;
}

/** One step a worker observed, metadata only: its target in its shaped form, where `…` marks words not kept. */
export interface RunStep {
  seq: number;
  callId: string | null;
  kind: StepKind;
  tool: string;
  target: string | null;
  outcome: StepOutcome;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** One page of an attempt's step log, in step order: the run's detail carries the latest attempt's first. */
export interface RunStepPage {
  attemptId: string;
  rows: RunStep[];
  cursor: string | null;
}

/** One call a run made back to the Deployment. */
export interface RunCall {
  id: number;
  status: 'success' | 'failed' | 'unknown';
  tool: string;
  op: string | null;
  durationMs: number | null;
  recordedAt: number;
  /** Present on a call the Deployment answered with a failure. */
  failure?: { code: string; message: string };
}

/** A spore as a run's outcome lists it: its line, never its body. */
export interface RunSpore {
  id: string;
  observationType: string;
  status: string;
  agentLine: string | null;
  sessionId: string | null;
  createdAt: number;
}

/** A session a run read, or worked from. */
export interface RunReadSession {
  sessionId: string;
  title: string | null;
  readAt: number | null;
}

/** `GET /api/projects/{p}/runs/{r}`: the run, its reports and calls, what it read and what it produced. */
export interface RunDetailAnswer {
  run: RunDetailFields;
  reports: readonly RunReport[];
  toolCalls: readonly RunCall[];
  toolCallCoverage: { total: number; failed: number; cursor: string | null };
  source: { branch: string; commit: string } | null;
  map: { revision: string; branch: string; commit: string; generatedAt: number; sourceRunId: string | null; replaced: boolean } | null;
  read: {
    sessions: readonly RunReadSession[];
    total: number;
    /** False when the run recorded no reads: the sessions are then the ones it worked from, and none listed means no record, not "read nothing". */
    recorded: boolean;
  };
  produced: { spores: { total: number; items: readonly RunSpore[] } };
  /** The run's latest claims, oldest first; `attemptCount` counts them all, and 0 is a run no worker's claim recorded. */
  attempts: readonly RunAttempt[];
  attemptCount: number;
  /** The first page of the latest attempt's step log; null for a run with no recorded attempt. */
  steps: RunStepPage | null;
  projectId: string;
}

/** `POST /api/harness/dispatch`, answered 200: a run queued or started, or input that has not moved. */
export type DispatchAnswer = { outcome: 'unchanged' } | { runId: string; projectId: string; queued: boolean };

/** 429 from a dispatch: the member's day of this task is spent. `resetsAt` is null when members may not start the task at all. */
export interface DailyLimitRefusal {
  error: 'daily_limit';
  task: string;
  perDay: number;
  resetsAt: number | null;
}

/** 409 from a dispatch: the capability the task needs is switched off for the project. */
export interface CapabilityOffRefusal {
  error: 'capability_off';
  capability: string;
  message: string;
}

/** 403 from a dispatch that asked a member's run to start fresh. */
export interface FreshNeedsAdminRefusal {
  error: 'fresh_needs_admin';
}
