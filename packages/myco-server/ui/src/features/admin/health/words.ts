/**
 * Health's words: every sentence the page says about housekeeping, automatic
 * recovery, store maintenance and the measures, built from what the server
 * answers. A result is named for what it is: a staging is never called
 * recoverable, a failed read is never taken for a missing feature, and a
 * measure is never shown without its sample.
 */
import type { StatusResponse } from '../../../lib/api';
import { clockTime } from '../../today/words';
import { formatBytes, formatCount, formatRelative, formatUntil } from '../../../lib/format';
import type { Cadence, MaintenanceCheck, MaintenanceOutcome, RecoveryAvailability, RecoverySchedule, RecoveryProducerStatus, TickReport, JobReport } from './wire';

// ---------- Housekeeping ----------

const STATE_WORDS: Record<string, string> = { active: 'in use', idle: 'idle', sleep: 'asleep', deep_sleep: 'in deep sleep' };

/** One job's outcome in the reader's words: what changed, or that it did not run to the end. */
function jobWords(job: JobReport): string {
  if (job.failed !== null) {
    if (job.name === 'agent-run-retention') return 'old run records could not be removed';
    if (job.name === 'run-stale-sweep') return 'runs whose machine stopped answering could not be closed';
    return `${job.name} did not finish`;
  }
  const n = job.changed;
  const plural = n === 1 ? '' : 's';
  if (job.name === 'agent-run-retention') return `removed ${n} old run record${plural}`;
  if (job.name === 'run-stale-sweep') return `closed ${n} run${plural} whose machine stopped answering`;
  if (job.name === 'transcript-parse') return `read ${n} row${plural} from transcripts${job.more === true ? ', with more still to read' : ''}`;
  return `${job.name} changed ${n} row${plural}`;
}

/** What a wake did, in one paragraph: the state it found, each job, and when the next wake comes. */
export function reportWords(report: TickReport): string {
  const state = STATE_WORDS[report.state] ?? report.state;
  const held = report.heldBy === 'run:live' ? ' while a run is live' : '';
  const jobs = report.jobs.length === 0 ? 'Nothing was due.' : `${report.jobs.map(jobWords).join('; ')}.`;
  const next = report.nextWakeMs === null ? 'No wake is scheduled while it sleeps this deeply.'
    : report.nextWakeMs < 60_000 ? `Next wake in ${Math.max(1, Math.round(report.nextWakeMs / 1_000))} s.`
    : `Next wake in ${Math.max(1, Math.round(report.nextWakeMs / 60_000))} min.`;
  return `The server is ${state}${held}. ${jobs.charAt(0).toUpperCase()}${jobs.slice(1)} ${next}`;
}

/** The transcripts waiting to be read, in the reader's words; null when there are none or the count is not known. */
export function backlogWords(backlog: StatusResponse['transcriptBacklog']): string | null {
  if (backlog === undefined || backlog === null || backlog.transcripts === 0) return null;
  return `${formatCount(backlog.transcripts, 'transcript')} (${formatBytes(backlog.bytes)}) waiting to be read into sessions.`;
}

// ---------- Automatic recovery ----------

/** An instant as every page writes one: "Sep 1, 12:00", with the year when it is not this one. */
const dateLabel = (ms: number, now: number = Date.now()): string => {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}, ${clockTime(ms)}`;
};

/** How long until an instant, in the coarse words a cadence deserves. */
export function whenLabel(at: number, now: number): string {
  if (at <= now) return 'now';
  return at - now < 48 * 60 * 60 * 1000 ? `in ${formatUntil(at, now, true)}` : `on ${dateLabel(at)}`;
}

/** What a server that runs no automatic recovery says of it. */
export const RECOVERY_UNAVAILABLE_WORDS = 'Automatic recovery doesn’t run on this server. Use Create backup above, or the operator backup procedure.';

/** What the recovery schedule is doing, in one line an owner can act on. */
export function cadenceWords(schedule: RecoverySchedule, now: number): string {
  if (!schedule.supported) return RECOVERY_UNAVAILABLE_WORDS;
  if (!schedule.configured) return 'Automatic recovery is off. Set “Back up every” in Settings to schedule it.';
  const every = `Every ${schedule.intervalHours} h.`;
  if (!schedule.ready) return `${every} It can’t run yet: this server is missing something it needs.`;
  if (schedule.idleBecause !== null) return `${every} The next one waits for the attempt or backup in progress to end.`;
  if (schedule.dueAt === null) return every;
  return schedule.due ? `${every} Due now, at the next wake.` : `${every} Next due ${whenLabel(schedule.dueAt, now)}.`;
}

/** What this Deployment's producer produces, which every sentence below reads before naming a result. */
export type RecoveryForm = RecoveryProducerStatus['form'];

/**
 * What the last attempt did, or that none has run. Numbered attempts are named
 * by their number; an attempt that is a whole artifact is named by when it
 * started, which is what identifies it on disk.
 */
export function latestWords(schedule: RecoverySchedule, form: RecoveryForm = 'staging'): string {
  const latest = schedule.latest;
  if (latest === null) return 'No attempt has run yet.';
  const which = form === 'artifact' ? 'The last attempt' : `Attempt ${latest.attempt}`;
  const when = latest.startedAt === null ? '' : ` started ${dateLabel(latest.startedAt)}`;
  // A waiting attempt is still advancing: what it waits on, and for how long, is what an owner reads.
  const since = latest.waitingSince == null ? '' : ` (requested ${formatRelative(latest.waitingSince)})`;
  if (latest.waiting === 'earlier_export') return `${which}${when} is waiting for an earlier export to end before it starts its own${since}.`;
  if (latest.waiting === 'own_request') return `${which}${when} is waiting to learn whether the export it asked for started${since}.`;
  // A refusal is the attempt's outcome only once it failed; an advancing attempt's is a transient it spent.
  if (latest.stage === 'failed') return `${which}${when} failed${latest.failure === null ? '' : `: ${PRODUCER_FAILURE_WORDS[latest.failure] ?? 'the operator log names why'}`}.`;
  if (latest.stage === 'complete') {
    return form === 'artifact' ? `${which}${when} wrote a complete artifact.` : `${which}${when} staged everything it named.`;
  }
  return `${which}${when} is ${stageWords(latest.stage)}.`;
}

/** Why an attempt failed, from the producer's closed set of refusals, in words. */
const PRODUCER_FAILURE_WORDS: Readonly<Record<string, string>> = {
  provider_unavailable: 'the storage provider could not be reached',
  provider_refused: 'the storage provider refused',
  export_failed: 'the database export failed',
  export_not_offered: 'the database offers no export',
  export_unparsable: 'the export could not be read',
  export_stalled: 'the export stopped making progress',
  export_unanswered: 'the export it asked for never answered',
  export_unsettled: 'an earlier export never finished',
  artifact_refused: 'the backup was refused',
  artifact_cancelled: 'the backup was cancelled',
  download_unranged: 'the download could not resume',
  download_changed: 'the export changed while it downloaded',
  download_lost: 'the download was lost',
  staging_unreconciled: 'what it saved could not be checked',
  staging_changed: 'what it saved changed underneath it',
  inventory_disagrees: 'what it saved does not match the export',
  inventory_unreadable: 'what it saved could not be listed',
  inventory_oversize: 'the export is larger than it can hold',
  object_missing: 'a stored file was missing',
  object_changed: 'a stored file changed while it copied',
  copy_stalled: 'copying stopped making progress',
  staging_incomplete: 'what it saved is incomplete',
  schema_disagrees: 'the database version does not match',
  producer_stalled: 'it stopped making progress',
  internal: 'the server had a problem',
};

/** An attempt's stage, from the producer's closed set, in words. */
const STAGE_WORDS: Readonly<Record<string, string>> = {
  export: 'exporting the database',
  download: 'downloading the export',
  inventory: 'checking what it downloaded',
  copy: 'copying the files',
  downloaded: 'downloaded',
  complete: 'complete',
  unconfirmed: 'waiting to be confirmed',
  failed: 'failed',
};

function stageWords(stage: string): string {
  return STAGE_WORDS[stage] ?? 'in progress';
}

/** The attempt the producer answered, for a reading whose schedule is unavailable. */
export function attemptWords(attempt: number | null, stage: string | null, form: RecoveryForm = 'staging'): string {
  if (attempt === null || stage === null) return 'No attempt has run yet.';
  return form === 'artifact' ? `The last attempt is ${stageWords(stage)}.` : `Attempt ${attempt} is ${stageWords(stage)}.`;
}

/**
 * What recovery data exists, in the only words that are true of what this
 * Deployment's producer wrote. A staging is not a recovery artifact until an
 * operator materializes and verifies it; an artifact is one, and still data
 * alone, so what a restore needs beside it is named.
 */
export function availableWords(available: RecoveryAvailability): string {
  if (available.state === 'none') return 'No recovery data exists yet.';
  if (available.state === 'incomplete') return `Attempt ${available.attempt} is ${stageWords(available.stage)}: nothing it has written can be recovered from yet.`;
  if (available.state === 'artifact') {
    return `A complete, verified recovery artifact is ready at ${available.at}. Restoring it also needs the key this server keeps its stored secrets under, which is kept apart from it.`;
  }
  return `Attempt ${available.attempt} holds a complete staging. It is not a recovery artifact yet — an operator materializes and verifies it into one.`;
}

// ---------- Store maintenance ----------

export const CHECK_TITLES: Record<MaintenanceCheck, string> = { optimize: 'Optimize', integrity: 'Integrity check' };

const MEASUREMENT_WORDS: Record<string, string> = { size: 'Size', reclaimable: 'Reclaimable', size_limit: 'Size limit', daily_quota: 'Daily usage', blob_bytes: 'Stored files' };

const FAILURE_WORDS: Record<string, string> = {
  store_quota: 'the store reached its daily usage limit',
  store_size: 'the store is at its size limit',
  db: 'the store refused the check',
  constraint: 'the store refused the check',
  schema: 'the store is not at the schema this server expects',
};

export const measurementName = (name: string): string => MEASUREMENT_WORDS[name] ?? name;

export function checkCadenceWords(cadence: Cadence): string {
  if (cadence.state === 'on') return `Runs automatically every ${cadence.intervalHours} hours.`;
  if (cadence.state === 'off') return 'Automatic runs are off.';
  if (cadence.state === 'invalid') return 'Automatic runs are not scheduled: the saved setting is invalid.';
  return 'Automatic runs are not set up. Turn them on and choose an interval under Settings · Backups.';
}

/** A `running` record is live only while the server reports the check running; otherwise its run ended without recording an outcome. */
export function outcomeWords(outcome: MaintenanceOutcome, running: boolean): string {
  const when = dateLabel(outcome.finishedAt ?? outcome.startedAt);
  const by = outcome.trigger === 'owner' ? 'run by hand' : 'scheduled';
  if (outcome.state === 'running') {
    return running
      ? `Running since ${dateLabel(outcome.startedAt)} (${by}).`
      : `Interrupted: started ${dateLabel(outcome.startedAt)} (${by}) and ended without recording an outcome.`;
  }
  if (outcome.state === 'healthy') return `No problems found ${when} (${by}).`;
  if (outcome.state === 'findings') return `Problems found ${when} (${by}):`;
  return `Did not finish ${when} (${by}): ${FAILURE_WORDS[outcome.errorClass ?? ''] ?? 'it failed'}.`;
}

// ---------- Backups ----------

/** A backup's size, as a person reads it. */
export const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export const backupDate = (ms: number): string => dateLabel(ms);

/** What a restore would add, table by table, in words: "sessions 12 · spores 40". Tables adding nothing are left out. */
export function countsWords(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([table, n]) => `${table.replace(/_/g, ' ')} ${n.toLocaleString()}`);
  return parts.length === 0 ? 'It holds no records.' : parts.join(' · ');
}

// ---------- Measures ----------

export const percent = (share: number): string => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
/** A count and what it counts, agreeing in number the way every sample line does. */
export const countOf = (n: number, unit: string): string => `${n.toLocaleString()} ${n === 1 ? unit : `${unit}s`}`;
export const perUnit = (n: number): string => n.toFixed(n >= 10 ? 0 : 2);
/** The sample behind a measure, always said: "n = 1,234 prompts". */
export const sampleWords = (sampleSize: number, unit: string): string => `n = ${countOf(sampleSize, unit)}`;

/** What the server can run itself, in the reader's words, by the capability it reports. */
const CAPABILITY_WORDS: Readonly<Record<string, string>> = {
  'relational-store': 'Database for sessions and knowledge',
  'blob-store': 'File storage for transcripts and attachments',
  'rate-limiting': 'Limits on how fast machines may send',
  'harness-runtime': 'Running Myco’s tasks on this server',
};

/** A capability as Health names it: its own words, else the server's label. */
export function capabilityWords(capability: { capability: string; label: string }): string {
  return CAPABILITY_WORDS[capability.capability] ?? capability.label;
}
