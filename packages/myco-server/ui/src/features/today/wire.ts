import type { RecordedIdentity, CostProvenance } from '@goondocks/myco-shared/worker-usage';

/**
 * The shapes Today reads off the wire: `/api/work`, `/api/attention`,
 * `/api/uncaptured` and its connect, the `capture` rows of `/api/status`, and
 * the fields it reads of a session and a spore listed across Projects.
 *
 * The server's own declarations (`read/work.ts`, `core/attention.ts`,
 * `read/capture.ts`, `read/sessions.ts`, `core/spores.ts`) pull in the server's
 * runtime modules, which this dashboard's build does not carry, so the shapes
 * are declared here and held to the server's by
 * `tests/myco-server/today-wire.test.ts`, which the tests typecheck compiles.
 * This file imports only shared accounting types, so that check can read it outside the dashboard.
 */

/** What an outcome task produces. */
export type OutcomeKind = 'learn' | 'title' | 'map' | 'seed';

export type Range = readonly [number, number] | null;

/** One Project's work of one kind over the window. */
export interface WorkOutcome {
  projectId: string;
  kind: OutcomeKind;
  task: string;
  runs: Record<string, number>;
  outcome: { spores: number; sessions: number; maps: number };
  failedWithOutput: number;
  failed: number;
  latestAt: number | null;
  tokens: number;
  costUsd: number;
  runsWithoutCost: number;
  spend: { tokens: Range; costUsd: Range; durationMs: Range };
  map: { branch: string; commit: string; generatedAt: number; sourceRunId: string } | null;
}

/** How a listed run ended, by what it produced. */
export type RunResult = 'produced' | 'failed' | 'failed_with_output';

/** One run the timeline lists: one that produced something, or one that failed. */
export interface WorkRun {
  identity: RecordedIdentity;
  costProvenance: CostProvenance | null;
  provider: string | null;
  harness: string | null;
  model: string | null;

  id: string;
  projectId: string;
  task: string;
  kind: OutcomeKind;
  status: string;
  result: RunResult;
  at: number | null;
  outcome: { spores: number; sessions: number; maps: number };
  sessionId: string | null;
  failure: { cause: string; code?: string | null; error?: string | null; source: 'report' | 'error' } | null;
  tokens: number | null;
  costUsd: number | null;
}

/** The search index's upkeep over the window. */
export interface Upkeep {
  task: string;
  lastSuccessAt: number | null;
  failedInWindow: number;
  unrecovered: { runs: number; since: number } | null;
}

/** `GET /api/work`. */
export interface WorkAnswer {
  window: { since: number; until: number };
  outcomes: WorkOutcome[];
  runs: WorkRun[];
  truncated: boolean;
  upkeep: Upkeep;
}

/** One thing an administrator should act on: a kind, a tone and the numbers its words need. */
export type AttentionItem =
  | { kind: 'backup_overdue'; tone: 'warn'; lastBackupAt: number | null; intervalHours: number }
  | { kind: 'outcome_failed'; tone: 'bad'; projectId: string; outcome: OutcomeKind; task: string; failures: number; since: number; latestAt: number; runId: string }
  | { kind: 'search_index_behind'; tone: 'warn'; pendingBlobs: number; pendingSince: number | null; failedUpdates: number; failingSince: number | null; lastSuccessAt: number | null }
  | { kind: 'transcripts_stopped'; tone: 'warn'; projectId: string; transcripts: number; latestAt: number | null; reasons: Record<string, number> }
  | { kind: 'runs_held_for_capability'; tone: 'warn'; capability: string; runs: number; since: number }
  | { kind: 'no_worker'; tone: 'bad'; runs: number; since: number | null; lastContactAt: number | null }
  | { kind: 'access_key_expiring'; tone: 'warn'; grantId: string; projectId: string; label: string | null; expiresAt: number }
  | { kind: 'schema_mismatch'; tone: 'bad'; expected: number; found: number | null };

export type AttentionKind = AttentionItem['kind'];

/** `GET /api/attention`. */
export interface AttentionAnswer {
  items: AttentionItem[];
  /** The rules whose facts could not be read, so their absence from `items` says nothing. */
  unavailable: AttentionKind[];
}

/** Why a member's machine is not capturing a repository: outside its folders, no remote, or refused by the server. */
export type UncapturedReason = 'outside_folders' | 'no_remote' | 'refused' | 'auto_create_off' | 'archived';

/** What the machine still holds of that repository's capture: all of it, no more past its cap, or none past its age. */
export type HeldState = 'held' | 'full' | 'expired';

/** One repository a member's machine is not capturing yet, as "Needs you" lists it. */
export interface UncapturedRootItem {
  machineId: string;
  /** The machine's name, to the member it belongs to alone; null to anyone else, and while it has none. */
  machineName: string | null;
  member: { id: string; label: string | null };
  rootKey: string;
  /** The repository's folder name, never a path. */
  label: string;
  remote: string | null;
  reason: UncapturedReason;
  misses: number;
  held: HeldState;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** `GET /api/uncaptured`. */
export interface UncapturedAnswer {
  items: UncapturedRootItem[];
}

/** `POST /api/uncaptured/{machineId}/{rootKey}/connect`: the project to join, or none for the one its remote names, or a new one. */
export interface ConnectRequest {
  projectId?: string;
}

/** Why a connect is refused, in `error`: an archived project holds its remote, another project does, or no project does and its member may not start one. */
export type ConnectRefusalCode = 'archived' | 'remote_bound' | 'auto_create_off';

/** A refused connect's answer: the code, with the server's words in `reason`. */
export interface ConnectRefusal {
  error: ConnectRefusalCode;
  reason: string;
}

/** What the connect answers: the machine joins at a hook in the repository, within minutes. */
export interface ConnectAnswer {
  connected: true;
  machineId: string;
  rootKey: string;
  projectId: string | null;
}

/** One machine and agent: when it last sent anything, and the Project that capture landed in. */
export interface CaptureRow {
  machineId: string;
  /** The machine's name, served to the member it belongs to alone; null to anyone else, and while it has none. */
  machineName: string | null;
  /** The member the machine belongs to, served to every viewer; Myco's own runtime is named Myco. */
  member: { id: string; label: string | null } | null;
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

/** The fields Today reads of a session listed across Projects. */
export interface TodaySession {
  projectId: string;
  sessionId: string;
  agent: string | null;
  startedAt: number | null;
  firstReceivedAt: number;
  lastReceivedAt: number;
  endedAt: number | null;
  memberId: string | null;
  memberLabel: string | null;
  runtimeLabel: string | null;
  title: string | null;
  summary: string | null;
  label: string;
  promptCount: number;
}

/** A page of `GET /api/sessions`. */
export interface TodaySessionPage {
  readonly rows: readonly TodaySession[];
  readonly cursor: string | null;
}

/** The fields Today reads of a spore listed across Projects. */
export interface TodaySpore {
  projectId: string;
  id: string;
  observationType: string;
  status: string;
  content: string;
  agentLine: string | null;
  /** The run, member or grant that wrote it. */
  author: string | null;
  createdAt: number;
}

/** A page of `GET /api/spores`. */
export interface TodaySporePage {
  readonly spores: readonly TodaySpore[];
  readonly total: number;
}
