/**
 * The shapes the Sessions pages read off the wire: a row of `GET /api/sessions`
 * and the `outcome` and `resume` of `GET /api/projects/{p}/sessions/{s}`.
 *
 * The server's declarations (`read/catalog/sessions.ts`, `read/run-reads.ts`) pull in
 * the server's runtime modules, which this dashboard's build does not carry, so
 * the shapes are declared here and held to the server's by
 * `tests/myco-server/sessions-wire.test.ts`, which the tests typecheck compiles.
 * This file imports nothing, so that check can read it outside the dashboard.
 */

/** The fields the table reads of a session listed across Projects. */
export interface SessionListRow {
  projectId: string;
  sessionId: string;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  firstReceivedAt: number;
  lastReceivedAt: number;
  endedAt: number | null;
  /** When the session stops being live unless it sends more: the server's idle close past its last receipt. Null when it is not live. */
  liveUntil: number | null;
  memberId: string | null;
  memberLabel: string | null;
  runtimeLabel: string | null;
  title: string | null;
  summary: string | null;
  label: string;
  promptCount: number;
  toolCallCount: number;
}

/** A page of `GET /api/sessions`. */
export interface SessionListPage {
  readonly rows: readonly SessionListRow[];
  readonly cursor: string | null;
}

/** A spore as an outcome lists it: its line, never its body. */
export interface OutcomeSpore {
  id: string;
  observationType: string;
  status: string;
  agentLine: string | null;
  sessionId: string | null;
  createdAt: number;
  /** The run that wrote it, while the Project still holds that run; null for a spore a member or a grant wrote. */
  runId: string | null;
}

/** A run that read a session, wrote from it, or was dispatched on it. */
export interface SessionRun {
  runId: string;
  task: string | null;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  /** When the run first read the session; null when the Deployment holds no record of its reading it, which is not the same as its reading nothing. */
  readAt: number | null;
  /** Whether the run's dispatch named this session. */
  target: boolean;
  /** Whether the run wrote this session's title. */
  titled: boolean;
  /** How many spores the run wrote from this session. */
  spores: number;
}

/** What came of one session: the runs that read it or wrote from it, newest first, and the spores written from it. */
export interface SessionOutcome {
  runs: SessionRun[];
  spores: { total: number; items: OutcomeSpore[] };
}

/** How `GET /api/projects/{p}/sessions/{s}` says to resume the session in its agent: the command, and the line to paste, which enters the session's folder first. */
export interface ResumeCommand {
  command: string;
  line: string;
}

/** Invocation confidence and labels carried by a displayed turn. */
export interface TurnInvocation {
  startAt: number;
  endAt: number | null;
  matchedBy: 'exact' | 'inferred';
  keyLabel: string | null;
  serviceName: string | null;
  agentName: string | null;
}

/** Observations retain their numeric counters; coverage is an independent fact. */
export interface SessionEvidence {
  toolCalls: number;
  failedTools: number;
  mycoCalls: number;
  turns: number;
  personTurns: number;
  promptEntries: number;
  nestedToolCalls: number;
  reportedErrors: number;
  filesEdited: number;
  observedFilesEdited: number;
  fileEdits: { state: 'count'; count: number } | { state: 'unknown'; observed: number } | { state: 'not_visible' };
  visibility: { reportedErrors: 'recorded' | 'not_visible'; nestedToolCalls: 'recorded' | 'not_visible'; toolCalls: 'recorded' | 'not_visible'; failedTools: 'recorded' | 'not_visible'; mycoCalls: 'recorded' | 'not_visible'; filesEdited: 'recorded' | 'observed' | 'not_visible'; commits: 'not_visible' };
  counts: { prompts: number; userPrompts: number; promptEntries: number; toolCalls: number; failedTools: number; mycoCalls: number; responses: number; plans: number; attachments: number };
}
