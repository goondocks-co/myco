import { QUEUE_REASON_WORDS, type FleetQueue } from '@goondocks/myco-shared/runner-fleet';
import { Card } from '../../../design';
import { formatRelative } from '../../../lib/format';

const WARN_AFTER_MS = 15 * 60_000;
const URGENT_AFTER_MS = 60 * 60_000;

/** Queue age belongs to the queued run; contact freshness does not reset it. */
export function QueueWarning({ queue }: { queue: FleetQueue | undefined }) {
  if (queue === undefined || (queue.count === 0 && !queue.nativeNeedsRunner)) return null;
  const blocked = queue.reasons.some(({ reason }) => reason !== 'ready' && reason !== 'capacity');
  const age = queue.oldestAt === null ? 0 : Date.now() - queue.oldestAt;
  const tone = blocked && age >= URGENT_AFTER_MS ? 'urgent' : blocked || age >= WARN_AFTER_MS ? 'warn' : 'neutral';
  return <Card className={`flex flex-col gap-s2 ${tone === 'urgent' ? 'bg-bad-bg' : tone === 'warn' ? 'bg-warn-bg' : ''}`} data-queue-warning="" data-tone={tone}>
    {queue.count > 0 && <>
      <p className="t-body text-ink">{queue.count} {queue.count === 1 ? 'run' : 'runs'} waiting; oldest {queue.oldestAt === null ? 'age unavailable' : formatRelative(queue.oldestAt)}.</p>
      {queue.reasons.map(({ reason, count }) => <p key={reason} className="t-small text-ink-2">{queue.reasons.length > 1 ? `${count} ${count === 1 ? 'run' : 'runs'}: ` : ''}{QUEUE_REASON_WORDS[reason]}</p>)}
      <p className="t-meta text-muted">Checked {formatRelative(queue.observedAt)}.</p>
    </>}
    {queue.nativeNeedsRunner && <p className="t-small text-ink-2">This native server no longer runs agent work by itself; register a runner on this machine or another to run Myco’s work.</p>}
  </Card>;
}
