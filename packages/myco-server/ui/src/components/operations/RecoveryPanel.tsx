import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { unsupported, useRecovery, type RecoveryAvailability, type RecoverySchedule } from '../../hooks/use-recovery';

const dateLabel = (ms: number): string => new Date(ms).toLocaleString();

/** How long until an instant, in the coarse words a cadence deserves. */
function whenLabel(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return 'now';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `on ${dateLabel(at)}`;
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

/** What the last attempt did, or that none has run. */
export function latestWords(schedule: RecoverySchedule): string {
  const latest = schedule.latest;
  if (latest === null) return 'No attempt has run yet.';
  const when = latest.startedAt === null ? '' : ` started ${dateLabel(latest.startedAt)}`;
  if (latest.failure !== null) return `Attempt ${latest.attempt}${when} failed: ${latest.failure.replace(/_/g, ' ')}.`;
  if (latest.stage === 'complete') return `Attempt ${latest.attempt}${when} staged everything it named.`;
  return `Attempt ${latest.attempt}${when} is ${latest.stage}.`;
}

/** The attempt the producer answered, for a reading whose schedule is unavailable. */
export function attemptWords(attempt: number | null, stage: string | null): string {
  if (attempt === null || stage === null) return 'No attempt has run yet.';
  return `Attempt ${attempt} is ${stage}.`;
}

/**
 * What recovery data exists — and, for a complete staging, what it is still not.
 *
 * A staging is not a recovery artifact: an operator materializes and verifies one into an artifact, and until
 * then there is nothing to restore from.
 */
export function availableWords(available: RecoveryAvailability): string {
  if (available.state === 'none') return 'No recovery data has been staged yet.';
  if (available.state === 'incomplete') return `Attempt ${available.attempt} is ${available.stage}: nothing staged by it can be recovered from yet.`;
  return `Attempt ${available.attempt} holds a complete staging. It is not a recovery artifact yet — an operator materializes and verifies it into one.`;
}

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
          <p className="font-sans text-sm text-on-surface-variant" data-testid="recovery-latest">{attemptWords(attempt, stage)}</p>
        </div>
      )}
      {schedule !== null && (
        <div className="flex flex-col gap-2">
          <p className="font-sans text-sm text-on-surface" data-testid="recovery-cadence">{cadenceWords(schedule, now)}</p>
          <p className="font-sans text-sm text-on-surface-variant" data-testid="recovery-latest">{latestWords(schedule)}</p>
          <p
            className={`font-sans text-sm ${schedule.available.state === 'staged' ? 'text-ochre' : 'text-on-surface-variant'}`}
            data-testid="recovery-available"
          >
            {availableWords(schedule.available)}
          </p>
          <p className="font-sans text-xs text-on-surface-variant">
            The interval lives in <Link to="/settings" className="text-primary underline">Settings</Link> as “Back up every”.
            Materializing a staging into a verified artifact, and restoring from one, are operator commands: see the{' '}
            <a className="underline" href="https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md">
              recovery procedure
            </a>.
          </p>
        </div>
      )}
    </Panel>
  );
}
