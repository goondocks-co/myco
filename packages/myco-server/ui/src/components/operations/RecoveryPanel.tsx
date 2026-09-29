import { Link } from 'react-router-dom';
import { formatRelative, formatUntil } from '../../lib/format';
import { Panel } from '../ui/panel';
import { unsupported, useForgetUnsettledExport, useRecovery, type RecoveryAvailability, type RecoverySchedule, type RecoveryStatus } from '../../hooks/use-recovery';

const dateLabel = (ms: number): string => new Date(ms).toLocaleString();

/** How long until an instant, in the coarse words a cadence deserves. */
function whenLabel(at: number, now: number): string {
  if (at <= now) return 'now';
  return at - now < 48 * 60 * 60 * 1000 ? `in ${formatUntil(at, now, true)}` : `on ${dateLabel(at)}`;
}

/** What the schedule is doing, in one line an owner can act on. */
export function cadenceWords(schedule: RecoverySchedule, now: number): string {
  if (!schedule.supported) return 'This Deployment runs no hosted recovery producer, so automatic recovery cannot run here.';
  if (!schedule.configured) return 'Automatic recovery is off. Set “Back up every” in Settings to schedule it.';
  const every = `Every ${schedule.intervalHours} h.`;
  if (!schedule.ready) return `${every} It cannot run yet: ${schedule.idleBecause ?? 'this Deployment cannot admit an attempt'}.`;
  if (schedule.idleBecause !== null) return `${every} ${schedule.idleBecause.charAt(0).toUpperCase()}${schedule.idleBecause.slice(1)}.`;
  if (schedule.dueAt === null) return every;
  return schedule.due ? `${every} Due now, at the next wake.` : `${every} Next due ${whenLabel(schedule.dueAt, now)}.`;
}

/**
 * What the last attempt did, or that none has run.
 *
 * Numbered attempts are named by their number; an attempt that is a whole artifact is named by when it started,
 * which is what identifies it on disk.
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
  if (latest.stage === 'failed' && latest.failure !== null) return `${which}${when} failed: ${latest.failure.replace(/_/g, ' ')}.`;
  if (latest.stage === 'complete') {
    return form === 'artifact'
      ? `${which}${when} wrote a complete artifact.`
      : `${which}${when} staged everything it named.`;
  }
  return `${which}${when} is ${latest.stage}.`;
}

/** The attempt the producer answered, for a reading whose schedule is unavailable. */
export function attemptWords(attempt: number | null, stage: string | null, form: RecoveryForm = 'staging'): string {
  if (attempt === null || stage === null) return 'No attempt has run yet.';
  return form === 'artifact' ? `The last attempt is ${stage}.` : `Attempt ${attempt} is ${stage}.`;
}

/**
 * What recovery data exists, in the only words that are true of what this Deployment's producer wrote.
 *
 * A staging is not a recovery artifact: an operator materializes and verifies one into an artifact, and until
 * then there is nothing to restore from. An artifact is one — and it is still data alone, so the credentials a
 * restore needs beside it are named rather than assumed.
 */
export function availableWords(available: RecoveryAvailability): string {
  if (available.state === 'none') return 'No recovery data exists yet.';
  if (available.state === 'incomplete') return `Attempt ${available.attempt} is ${available.stage}: nothing it has written can be recovered from yet.`;
  if (available.state === 'artifact') {
    return `A complete, verified recovery artifact is ready at ${available.at}. ${available.needs.charAt(0).toUpperCase()}${available.needs.slice(1)}.`;
  }
  return `Attempt ${available.attempt} holds a complete staging. It is not a recovery artifact yet — an operator materializes and verifies it into one.`;
}

/** What this Deployment's producer produces, which every sentence above reads before naming a result. */
export type RecoveryForm = RecoveryStatus['form'];

/**
 * Automatic recovery, as the Deployment's owner reads it: whether it is configured, when the next attempt is due,
 * what the last one did, and what data exists. Read only; the schedule runs on the Deployment's own clock.
 *
 * The complete-recovery surface, separate from the small additive Backup export above it.
 */
/**
 * The way out of an export that never settles: every later attempt waits on it and fails. Once the provider has said
 * nothing of it for long enough to take it as ended, an admin may have it forgotten; until then the control says when.
 * Offered only where the latest attempt failed that way.
 */
function ForgetUnsettledExport({ forgettableAt, now }: { forgettableAt: number | null; now: number }) {
  const forget = useForgetUnsettledExport();
  const early = forgettableAt !== null && forgettableAt > now;
  const words = forget.data !== undefined
    ? (forget.data.forgotten === null ? 'No earlier export was recorded; the next attempt starts its own.' : `The export attempt ${forget.data.forgotten.attempt} requested is forgotten; the next attempt starts its own.`)
    : forget.error !== null ? `It was not forgotten: ${forget.error.message}` : null;
  return (
    <div className="flex flex-col gap-1" data-testid="recovery-unsettled">
      <p className="font-sans text-sm text-ochre">
        The last attempt stopped because an export an earlier attempt started never said it ended, and every attempt waits on it.
        {early
          ? ` It was reported running too recently to be taken as ended; it can be forgotten ${whenLabel(forgettableAt!, now)}.`
          : ' Nothing has been heard of it for long enough to take it as ended: forget it so the next attempt starts its own.'}
      </p>
      <div>
        <button type="button" className="rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
          disabled={forget.isPending || early} onClick={() => forget.mutate()}>Forget the earlier export</button>
      </div>
      {words !== null && <p className="font-sans text-xs text-on-surface-variant">{words}</p>}
    </div>
  );
}

export function RecoveryPanel() {
  const recovery = useRecovery();
  const now = Date.now();
  const held = recovery.data?.schedule ?? null;
  const schedule = held !== null && 'unreadable' in held ? null : held;
  const unreadable = held !== null && 'unreadable' in held ? held.unreadable : null;
  // The producer's answer stands on its own: an unreadable schedule hides the cadence, not the attempt.
  const attempt = recovery.data?.attempt ?? null;
  const stage = recovery.data?.stage ?? null;
  // What this Deployment's producer produces decides what its results may be called.
  const form = recovery.data?.form ?? 'staging';

  return (
    <Panel title="Automatic recovery" eyebrow="Server">
      {recovery.isPending && <p className="font-sans text-sm text-on-surface-variant">Loading…</p>}
      {recovery.error !== null && unsupported(recovery.error) && (
        <p className="font-sans text-sm text-on-surface-variant" data-testid="recovery-unavailable">
          This Deployment runs no hosted recovery producer, so automatic recovery cannot run here.
        </p>
      )}
      {recovery.error !== null && !unsupported(recovery.error) && (
        <p className="font-sans text-sm text-ochre" data-testid="recovery-unreadable">
          Automatic recovery could not be read: {recovery.error.message}
        </p>
      )}
      {unreadable !== null && (
        <div className="flex flex-col gap-2">
          <p className="font-sans text-sm text-ochre" data-testid="recovery-unreadable">{unreadable}</p>
          <p className="font-sans text-sm text-on-surface-variant" data-testid="recovery-latest">{attemptWords(attempt, stage, form)}</p>
        </div>
      )}
      {recovery.data?.error === 'export_unsettled' && <ForgetUnsettledExport forgettableAt={recovery.data.unsettledExport?.forgettableAt ?? null} now={now} />}
      {schedule !== null && (
        <div className="flex flex-col gap-2">
          <p className="font-sans text-sm text-on-surface" data-testid="recovery-cadence">{cadenceWords(schedule, now)}</p>
          <p className="font-sans text-sm text-on-surface-variant" data-testid="recovery-latest">{latestWords(schedule, form)}</p>
          <p
            className={`font-sans text-sm ${schedule.available.state === 'staged' ? 'text-ochre' : 'text-on-surface-variant'}`}
            data-testid="recovery-available"
          >
            {availableWords(schedule.available)}
          </p>
          <p className="font-sans text-xs text-on-surface-variant">
            The interval lives in <Link to="/settings" className="text-primary underline">Settings</Link> as “Back up every”.
            {form === 'artifact'
              ? ' Restoring from an artifact is an operator command: see the '
              : ' Materializing a staging into a verified artifact, and restoring from one, are operator commands: see the '}
            <a className="underline" href="https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md">
              recovery procedure
            </a>.
          </p>
        </div>
      )}
    </Panel>
  );
}
