/**
 * Needs you: what on this Deployment an administrator should act on, now.
 *
 * Each item is a kind, a tone and the numbers its words need, never prose: the dashboard words it. Every rule reads
 * the state the problem is in rather than the events that passed through it, so a failure something later recovered
 * from is never an item:
 *
 * - the last backup is older than twice its interval, or there is none while automatic backups are configured;
 * - a learning or map outcome failed, and no later run of that task completed in that Project;
 * - the search index is behind: text has waited for it longer than `SEARCH_BEHIND_MS`, or its updates have failed
 *   for that long with no success after them;
 * - transcripts the current parser stopped on a fault;
 * - runs held longer than `CAPABILITY_HOLD_MS` for a capability no worker reports;
 * - runs are queued for a worker and no worker has been heard from lately;
 * - an access key expires within `ACCESS_KEY_NOTICE_MS`;
 * - the schema the store holds is not the one this server expects.
 *
 * A rule whose read fails is named in `unavailable` and the others still answer, so one unreadable fact never hides
 * the rest, and an empty list with nothing unavailable means nothing needs anyone.
 */
import type { ServerEnv } from './adapters.js';
import { CAPABILITY_HOLDS } from '@goondocks/myco-shared/run-holds';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { schemaVersion } from '../read/meta.js';
import { capabilityHolds, failingOutcomes, readUpkeep, runsAwaitingWorker, type OutcomeKind } from '../read/work.js';
import { stoppedTranscripts } from '../ingest/parse.js';
import { searchBacklog } from './search-index.js';
import { latestBackupAt } from './backup.js';
import { lastWorkerContactAt, CONTACT_RECENT_MS } from './worker-contacts.js';
import { grantsExpiringBy } from '../auth/grants.js';
import { scheduledIntervalHours } from './recovery-schedule.js';
import { within } from './recovery-inventory.js';
import { RUNTIME_SERVED_TASKS } from './harness.js';
import { EXTRACTION_TASK } from './task-catalogue.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long text may wait for the search index, or its updates keep failing, before the index counts as behind. */
export const SEARCH_BEHIND_MS = 30 * MINUTE_MS;
/** How long a run may wait for a worker capability no worker reports before it needs someone. */
export const CAPABILITY_HOLD_MS = 30 * MINUTE_MS;
/** How far ahead an access key's expiry is announced. */
export const ACCESS_KEY_NOTICE_MS = 7 * DAY_MS;
/** How far back a failed outcome is looked for; an older failure nothing retried has stopped being news. */
export const OUTCOME_LOOKBACK_MS = 7 * DAY_MS;
/** How long the recovery producer is given to say what its last attempt did. */
const PRODUCER_STATUS_MS = 5_000;

/** The outcome tasks whose failure needs someone: learning and the code map. */
export const WATCHED_OUTCOME_TASKS: readonly string[] = [EXTRACTION_TASK, MAP_TASK];

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

export interface AttentionAnswer {
  items: AttentionItem[];
  /** The rules whose facts could not be read, so their absence from `items` says nothing. */
  unavailable: AttentionKind[];
}

type Rule = { kind: AttentionKind; read: (env: ServerEnv, now: number) => Promise<AttentionItem[]> };

/** The instant of the last backup, from the backup index and from the recovery producer's last complete attempt. */
async function lastBackup(env: ServerEnv): Promise<number | null> {
  const indexed = await latestBackupAt(env.db);
  if (env.recovery === undefined) return indexed;
  const recovery = env.recovery;
  const status = await within(() => recovery.status(), PRODUCER_STATUS_MS, Date.now);
  const produced = status.stage === 'complete' ? status.startedAt : null;
  return indexed === null ? produced : produced === null ? indexed : Math.max(indexed, produced);
}

const RULES: readonly Rule[] = [
  {
    kind: 'schema_mismatch',
    read: async (env) => {
      const found = await schemaVersion(env.db);
      return found === SERVER_SCHEMA_VERSION ? [] : [{ kind: 'schema_mismatch', tone: 'bad', expected: SERVER_SCHEMA_VERSION, found }];
    },
  },
  {
    kind: 'backup_overdue',
    read: async (env, now) => {
      if (env.recovery === undefined) return [];
      const intervalHours = await scheduledIntervalHours(env);
      if (intervalHours === null) return [];
      const lastBackupAt = await lastBackup(env);
      const overdue = lastBackupAt === null || now - lastBackupAt > 2 * intervalHours * HOUR_MS;
      return overdue ? [{ kind: 'backup_overdue', tone: 'warn', lastBackupAt, intervalHours }] : [];
    },
  },
  {
    kind: 'outcome_failed',
    read: async (env, now) => (await failingOutcomes(env.db, WATCHED_OUTCOME_TASKS, now - OUTCOME_LOOKBACK_MS)).map((f) => ({
      kind: 'outcome_failed', tone: 'bad', projectId: f.projectId, outcome: f.kind, task: f.task,
      failures: f.failures, since: f.since, latestAt: f.latestAt, runId: f.latestRunId,
    })),
  },
  {
    kind: 'search_index_behind',
    read: async (env, now) => {
      const backlog = await searchBacklog(env.db);
      const upkeep = await readUpkeep(env.db, { all: true }, now - OUTCOME_LOOKBACK_MS, now);
      const waiting = backlog.pending > 0 && backlog.oldestStoredAt !== null && now - backlog.oldestStoredAt > SEARCH_BEHIND_MS;
      const failing = upkeep.unrecovered !== null && now - upkeep.unrecovered.since > SEARCH_BEHIND_MS;
      if (!waiting && !failing) return [];
      return [{
        kind: 'search_index_behind', tone: 'warn',
        pendingBlobs: backlog.pending, pendingSince: backlog.oldestStoredAt,
        failedUpdates: upkeep.unrecovered?.runs ?? 0, failingSince: upkeep.unrecovered?.since ?? null, lastSuccessAt: upkeep.lastSuccessAt,
      }];
    },
  },
  {
    kind: 'transcripts_stopped',
    read: async (env) => (await stoppedTranscripts(env.db)).map((s) => ({
      kind: 'transcripts_stopped', tone: 'warn', projectId: s.projectId, transcripts: s.transcripts, latestAt: s.latestAt, reasons: s.reasons,
    })),
  },
  {
    kind: 'runs_held_for_capability',
    read: async (env, now) => (await capabilityHolds(env.db, CAPABILITY_HOLDS, now - CAPABILITY_HOLD_MS)).map((h) => ({
      kind: 'runs_held_for_capability', tone: 'warn', capability: h.capability, runs: h.runs, since: h.since,
    })),
  },
  {
    kind: 'no_worker',
    read: async (env, now) => {
      const waiting = await runsAwaitingWorker(env.db, RUNTIME_SERVED_TASKS);
      if (waiting.runs === 0) return [];
      const lastContactAt = await lastWorkerContactAt(env.db);
      const heard = lastContactAt !== null && now - lastContactAt <= CONTACT_RECENT_MS;
      return heard ? [] : [{ kind: 'no_worker', tone: 'bad', runs: waiting.runs, since: waiting.since, lastContactAt }];
    },
  },
  {
    kind: 'access_key_expiring',
    read: async (env, now) => (await grantsExpiringBy(env.db, now, now + ACCESS_KEY_NOTICE_MS)).map((g) => ({
      kind: 'access_key_expiring', tone: 'warn', grantId: g.id, projectId: g.projectId, label: g.label, expiresAt: g.expiresAt,
    })),
  },
];

/** Every rule, each read on its own so one that fails is named and the rest still answer. */
export async function readAttention(env: ServerEnv, now: number): Promise<AttentionAnswer> {
  const settled = await Promise.allSettled(RULES.map((rule) => rule.read(env, now)));
  const items: AttentionItem[] = [];
  const unavailable: AttentionKind[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') items.push(...outcome.value);
    else unavailable.push(RULES[i]!.kind);
  });
  return { items, unavailable };
}
