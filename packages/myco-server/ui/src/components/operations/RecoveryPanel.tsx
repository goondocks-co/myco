import { Link } from 'react-router-dom';
import { formatUntil } from '../../lib/format';
import { Panel } from '../ui/panel';
import { unsupported, useRecovery, type RecoveryAvailability, type RecoverySchedule, type RecoveryStatus } from '../../hooks/use-recovery';

const dateLabel = (ms: number): string => new Date(ms).toLocaleString();

/** How long until an instant, in the coarse words a cadence deserves. */
function whenLabel(at: number, now: number): string {
  if (at <= now) return 'now';
  return at - now < 48 * 60 * 60 * 1000 ? `in ${formatUntil(at, now)}` : `on ${dateLabel(at)}`;
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
  if (latest.failure !== null) return `${which}${when} failed: ${latest.failure.replace(/_/g, ' ')}.`;
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
