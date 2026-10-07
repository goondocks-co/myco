/**
 * Myco's work as the dashboard's jsdom suites stub it: a week of runs in one
 * project, shaped the way `/api/work`, a project's run list and a run's detail
 * answer, with production-shaped ids so the raw-id checks have something to
 * find if an id ever leaks.
 */
import type { WorkAnswer, WorkOutcome, WorkRun } from '../../packages/myco-server/ui/src/features/today/wire';
import type { RunDetailAnswer, RunPageRow } from '../../packages/myco-server/ui/src/features/work/wire';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Tuesday, September 29 2026, 16:00 local. */
export const NOW = new Date(2026, 8, 29, 16, 0, 0).getTime();
/** The week the page opens on: the six days before today, and today. */
export const WEEK = { since: new Date(2026, 8, 23).getTime(), until: new Date(2026, 8, 30).getTime() };
export const TODAY = { since: new Date(2026, 8, 29).getTime(), until: new Date(2026, 8, 30).getTime() };

export const ADMIN = { sub: '1', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
export const MEMBER = { sub: '2', login: 'lin', member: { id: 'mem_Hn5pC0dJfA9sEu', label: 'Lin', role: 'member' as const } };
export const MEMBERS = { members: [
  { id: ADMIN.member.id, label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  { id: MEMBER.member.id, label: 'Lin', role: 'member', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
] };

export const P = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
export const P2 = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const project = (projectId: string, name: string) => ({ projectId, name, createdAt: 0, sessionCount: 3, lastActivityAt: NOW - MINUTE, archivedAt: null, archivedBy: null });
export const PROJECTS = { projects: [project(P, 'Myco'), project(P2, 'Atlas web')] };

export const S1 = '0b6f0f55-8a36-5d0e-9c1b-6b1d0d3f2a11';
export const S2 = '1c7a1a66-9b47-5e1f-8d2c-7c2e1e4a3b22';

const RANGE_NONE = { tokens: null, costUsd: null, durationMs: null };

export const outcome = (over: Partial<WorkOutcome> & Pick<WorkOutcome, 'kind' | 'task'>): WorkOutcome => ({
  projectId: P, runs: { completed: 1 }, outcome: { spores: 0, sessions: 0, maps: 0 }, failedWithOutput: 0, failed: 0, failure: null, latestAt: NOW - HOUR,
  tokens: 0, costUsd: 0, runsWithoutCost: 0, spend: RANGE_NONE, map: null, ...over,
});

export const workRun = (over: Partial<WorkRun> & Pick<WorkRun, 'id' | 'kind' | 'task'>): WorkRun => ({
  requested: null,
  identity: { status: 'not_recorded' }, costProvenance: null, harness: null, model: null, provider: null,
  queuedAt: null, startedAt: null, completedAt: null,
  projectId: P, status: 'completed', result: 'produced', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 0 },
  sessionId: null, failure: null, tokens: 1000, costUsd: 0.1, ...over,
});

export const WEEK_WORK: WorkAnswer = {
  window: WEEK,
  outcomes: [
    outcome({
      kind: 'learn', task: 'extract-curate', runs: { completed: 2, failed: 1, skipped: 1 }, outcome: { spores: 6, sessions: 4, maps: 0 }, failedWithOutput: 1,
      latestAt: NOW - 2 * HOUR, tokens: 60_000, costUsd: 1.5, spend: { tokens: [18_000, 30_000], costUsd: [0.5, 0.96], durationMs: [5 * MINUTE, 8 * MINUTE] },
    }),
    outcome({
      kind: 'title', task: 'title-summary', runs: { completed: 2, skipped: 1 }, outcome: { spores: 0, sessions: 2, maps: 0 },
      latestAt: NOW - 3 * HOUR, tokens: 4_000, costUsd: 0, runsWithoutCost: 2,
    }),
    outcome({
      kind: 'map', task: 'canopy-map', runs: { completed: 1, failed: 1 }, outcome: { spores: 0, sessions: 0, maps: 1 }, failed: 1,
      failure: { runs: 1, since: NOW - 3.5 * HOUR, latestAt: NOW - 3.5 * HOUR, latestRunId: 'run_5e0b1c2d3f', producedSince: 0 },
      latestAt: NOW - 3.5 * HOUR, tokens: 1_600_000, costUsd: 2.1,
      spend: { tokens: [500_000, 2_000_000], costUsd: [1, 2.3], durationMs: [4 * MINUTE, 10 * MINUTE] },
      map: { branch: 'main', commit: '8194811abcdef0123', generatedAt: NOW - 20 * HOUR, sourceRunId: 'run_c19f7a0e55' },
    }),
  ],
  runs: [
    workRun({ id: 'run_4f1c9a2e7b', kind: 'learn', task: 'extract-curate', status: 'failed', result: 'failed_with_output', at: NOW - 2 * HOUR, outcome: { spores: 2, sessions: 3, maps: 0 }, failure: { cause: 'Saved 2 spores from 3 sessions before the turn budget ran out.', source: 'report' } }),
    workRun({ id: 'run_7d1e2f3a40', kind: 'title', task: 'title-summary', at: NOW - 3 * HOUR, sessionId: S1, outcome: { spores: 0, sessions: 1, maps: 0 } }),
    workRun({ id: 'run_7d1e2f3b51', kind: 'title', task: 'title-summary', at: NOW - 3 * HOUR - 4 * MINUTE, sessionId: S2, outcome: { spores: 0, sessions: 1, maps: 0 } }),
    workRun({ id: 'run_5e0b1c2d3f', kind: 'map', task: 'canopy-map', status: 'failed', result: 'failed', at: NOW - 3.5 * HOUR, failure: { cause: 'repo.sha256 is absent from this checkout, so the previous map is kept.', source: 'report' } }),
    workRun({ id: 'run_a2c4e6f801', kind: 'learn', task: 'extract-curate', at: NOW - 5 * HOUR, outcome: { spores: 4, sessions: 1, maps: 0 } }),
    workRun({ id: 'run_c19f7a0e55', kind: 'map', task: 'canopy-map', at: NOW - 20 * HOUR, outcome: { spores: 0, sessions: 0, maps: 1 } }),
  ],
  truncated: false,
  cursor: null,
  upkeep: { task: 'embedding-reconcile', lastSuccessAt: NOW - 80 * MINUTE, failedInWindow: 1, unrecovered: null },
};

/** Ada's and Lin's machines, with ids in the shape a machine's id takes (`<login>_<8 hex>`). */
export const STUDIO_ID = 'ada_3f9e21c4';
export const BUILDBOX_ID = 'lin_8b02d6aa';

/**
 * The machine a run ran on, as the server serves it to `viewer`: the machine's
 * name only to the member it belongs to, and to everyone the member it belongs to.
 */
const machine = (viewer: string, owner: { id: string; label: string }, credentialId: string, machineId: string, name: string) => ({
  credentialId, machineId, machineName: viewer === owner.id ? name : null, member: { id: owner.id, label: owner.label },
});

/** A run on a page of the project's list; it started five minutes before it ended unless it says otherwise. */
export const runRow = (over: Partial<RunPageRow> & Pick<RunPageRow, 'id' | 'task'>): RunPageRow & Record<string, unknown> => ({
  requested: null,
  identity: { status: 'not_recorded' }, costProvenance: null,
  result: over.status === 'failed' ? ((over.outcome?.spores ?? 0) > 0 ? 'failed_with_output' : 'failed') : over.status === 'skipped' || over.status === 'queued' ? null : 'produced',
  agentId: 'myco-agent', status: 'completed', model: null, startedAt: (over.completedAt ?? NOW - HOUR) - 5 * MINUTE, completedAt: NOW - HOUR, tokensUsed: 20_000, costUsd: 0.5,
  costSource: 'estimated', failed: false, queuedAt: null, heldBy: null, position: null, replaced: false, replaces: null, harness: 'claude-code', worker: null,
  startedBy: 'clock', targetSessionId: null, skipReason: null, outcome: { spores: 0, sessions: 0, readsRecorded: false },
  provider: null, resumedAt: null, dryRun: false, resumable: false, resumeStatus: null, leasedBy: null, leaseExpiresAt: null, ...over,
});

/** Each task's latest runs in the project, as `GET /api/projects/{p}/runs?task=` answers `viewer`. */
export function taskRunsFor(viewer: string): Record<string, RunPageRow[]> {
  const STUDIO = machine(viewer, { id: ADMIN.member.id, label: 'Ada' }, 'mt_studio01abcd', STUDIO_ID, 'Ada’s studio Mac');
  const BUILDBOX = machine(viewer, { id: MEMBER.member.id, label: 'Lin' }, 'mt_buildbox0abc', BUILDBOX_ID, 'Lin’s build box');
  const pageRow = (over: Partial<RunPageRow> & Pick<RunPageRow, 'id' | 'task'>) => runRow({ worker: STUDIO, ...over });
  return {
    'extract-curate': [
      pageRow({ id: 'run_d4e5f6a7b8', task: 'extract-curate', status: 'skipped', skipReason: 'capability_off', startedAt: NOW - 30 * MINUTE, completedAt: NOW - 30 * MINUTE, worker: null, tokensUsed: null, costUsd: null, harness: null }),
      pageRow({ id: 'run_4f1c9a2e7b', task: 'extract-curate', status: 'failed', failed: true, completedAt: NOW - 2 * HOUR, outcome: { spores: 2, sessions: 3, readsRecorded: false } }),
      pageRow({ id: 'run_a2c4e6f801', task: 'extract-curate', completedAt: NOW - 5 * HOUR, startedBy: MEMBER.member.id, harness: 'codex', outcome: { spores: 4, sessions: 1, readsRecorded: true } }),
    ],
    'title-summary': [
      pageRow({ id: 'run_7d1e2f3a40', task: 'title-summary', completedAt: NOW - 3 * HOUR, targetSessionId: S1, outcome: { spores: 0, sessions: 1, readsRecorded: true } }),
      pageRow({ id: 'run_7d1e2f3b51', task: 'title-summary', completedAt: NOW - 3 * HOUR - 4 * MINUTE, targetSessionId: S2, outcome: { spores: 0, sessions: 1, readsRecorded: true } }),
    ],
    'canopy-map': [
      pageRow({ id: 'run_5e0b1c2d3f', task: 'canopy-map', status: 'failed', failed: true, completedAt: NOW - 3.5 * HOUR, worker: BUILDBOX, harness: 'codex' }),
      pageRow({ id: 'run_c19f7a0e55', task: 'canopy-map', completedAt: NOW - 20 * HOUR, startedBy: ADMIN.member.id }),
    ],
    'vault-seed': [],
  };
}

/** The runs as the admin, Ada, reads them. */
export const TASK_RUNS = taskRunsFor(ADMIN.member.id);

export const spore = (id: string, author: string, type: string, line: string, sessionId: string | null = S1) => ({
  projectId: P, id, observationType: type, status: 'active', content: `${line}\n\nMore.`, agentLine: line, author, createdAt: NOW - 2 * HOUR,
  agentId: 'myco-agent', sessionId, promptId: null, context: null, importance: 5, filePath: null, tags: null, contentHash: null,
  properties: null, provenanceKind: null, provenanceRef: null, updatedAt: null, embedded: 0,
});

export const WEEK_SPORES = [
  spore('gotcha-1a2b3c4d', 'run_4f1c9a2e7b', 'gotcha', 'Hosted and self-hosted order ties differently; sort by path too.'),
  spore('bug_fix-2b3c4d5e', 'run_4f1c9a2e7b', 'bug_fix', 'A test reserving a fixed port races the ephemeral fallback.'),
  spore('decision-3c4d5e6f', 'run_a2c4e6f801', 'decision', 'Myco’s work shows outcomes per task.'),
  spore('pattern-4d5e6f70', 'run_a2c4e6f801', 'pattern', 'Every list takes its search from one filter bar.'),
  spore('gotcha-5e6f7081', 'run_a2c4e6f801', 'gotcha', 'A port the kernel hands out can be reused at once.'),
  spore('decision-6f708192', 'run_a2c4e6f801', 'decision', 'Canopy parity runs on both targets before a map change merges.'),
  spore('wisdom-708192a3', MEMBER.member.id, 'wisdom', 'A spore an agent saved during a session, never Myco’s.'),
];

export const sessionAnswer = (sessionId: string, title: string) => ({
  session: {
    projectId: P, sessionId, agent: 'codex', title, label: title, summary: null, startedAt: NOW - 4 * HOUR, firstReceivedAt: NOW - 4 * HOUR,
    lastReceivedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR, memberId: null, memberLabel: null, runtimeLabel: null, branch: null, originPath: null,
    parentSessionId: null, parentReason: null, endedBy: null, endedByLabel: null,
  },
  untitled: null, counts: { prompts: 3, toolCalls: 0, responses: 3, plans: 0, attachments: 0 }, release: null,
  outcome: { runs: [], spores: { total: 0, items: [] } }, resume: null, projectId: P,
});

/** One run's detail, as `GET /api/projects/{p}/runs/{r}` answers. */
export const runDetail = (
  run: RunPageRow,
  over: Partial<Omit<RunDetailAnswer, 'run' | 'reports'>> & { run?: Record<string, unknown>; reports?: ReadonlyArray<Omit<RunDetailAnswer['reports'][number], 'audit'> & { audit?: RunDetailAnswer['reports'][number]['audit'] }> } = {},
): RunDetailAnswer & Record<string, unknown> => ({
  source: null, map: null, toolCallCoverage: { total: over.toolCalls?.length ?? 0, failed: over.toolCalls?.filter((call) => call.failure !== undefined).length ?? 0, cursor: null },
  toolCalls: [], phases: [], outcomeEvidence: null, projectId: P,
  read: { sessions: [], total: 0, recorded: false },
  produced: { spores: { total: 0, items: [] } },
  attempts: [], attemptCount: over.attempts?.length ?? 0, steps: null,
  ...over,
  reports: (over.reports ?? []).map((report) => ({ ...report, audit: report.audit ?? null })),
  run: {
    ...run, instruction: null, instructions: null, sessionRef: null, actualCostUsd: null, estimatedCostUsd: run.costUsd, reasoningLevel: null, resumeMode: null,
    canCancel: false, cancelReason: 'Only the member who requested this run or an administrator can cancel it.',
    resumeAttempts: 0, error: null, dispatchedBy: null, usageData: null, actionsTaken: null, ...over.run,
  } as RunDetailAnswer['run'],
});
