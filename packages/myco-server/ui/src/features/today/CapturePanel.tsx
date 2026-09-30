import { Button, Card, errorWords, HealthDot, Skeleton, type HealthTone } from '../../design';
import { LIVE_WITHIN_MS } from './timeline';
import type { CaptureRow } from './wire';
import { useMe } from '../../hooks/use-me';
import { agentName, ago, machineNames } from './words';

const DAY = 24 * 60 * 60_000;

/** How recently an agent sent anything, as a dot and the words it stands for. */
export function recency(lastEventAt: number, now: number): { tone: HealthTone; live: boolean; label: string } {
  const age = now - lastEventAt;
  if (age <= LIVE_WITHIN_MS) return { tone: 'ok', live: true, label: 'Sending now' };
  if (age <= DAY) return { tone: 'ok', live: false, label: 'Sent today' };
  if (age <= 7 * DAY) return { tone: 'faint', live: false, label: 'Quiet this week' };
  return { tone: 'warn', live: false, label: 'Quiet for over a week' };
}

interface MachineGroup {
  machineId: string;
  name: string;
  rows: CaptureRow[];
}

/** The rows by machine, each machine in the order of its most recent capture. */
export function byMachine(rows: readonly CaptureRow[], viewerId: string | null = null): MachineGroup[] {
  const sorted = [...rows].sort((a, b) => b.lastEventAt - a.lastEventAt);
  const names = machineNames(sorted, viewerId);
  const groups = new Map<string, MachineGroup>();
  for (const row of sorted) {
    const group = groups.get(row.machineId) ?? { machineId: row.machineId, name: names.get(row.machineId)!, rows: [] };
    group.rows.push(row);
    groups.set(row.machineId, group);
  }
  return [...groups.values()];
}

export interface CapturePanelProps {
  rows: readonly CaptureRow[] | undefined;
  /** Whether the server said it could not read capture. */
  unavailable: boolean;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
}

/**
 * Capture: whether each machine's agents are reaching Myco. The machine that
 * sent last is listed agent by agent; each other machine gets one line.
 */
export function CapturePanel({ rows, unavailable, pending, error, onRetry, now }: CapturePanelProps) {
  const viewerId = useMe().data?.member?.id ?? null;
  const groups = rows === undefined ? [] : byMachine(rows, viewerId);
  const [first, ...others] = groups;
  return (
    <Card className="flex flex-col gap-s3" data-capture="">
      <div className="flex min-w-0 items-baseline gap-s2">
        <h2 className="t-h2 text-ink">Capture</h2>
        {first !== undefined && <span className="min-w-0 truncate t-small text-muted">{first.name}</span>}
      </div>
      {pending ? (
        <div role="status" aria-label="Loading capture" className="flex flex-col gap-s2">
          <Skeleton className="h-s4 w-3/5" />
          <Skeleton className="h-s4 w-2/5" />
        </div>
      ) : rows === undefined ? (
        <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-muted">
          <span>Couldn’t read capture: {errorWords(error).title.replace(/\.$/, '').toLowerCase()}.</span>
          {errorWords(error).retry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
        </div>
      ) : unavailable ? (
        <p className="t-small text-muted">Couldn’t read capture just now.</p>
      ) : first === undefined ? (
        <p className="t-small text-muted">No machine has sent anything in the last 30 days.</p>
      ) : (
        <>
          <ul aria-label={`Agents on ${first.name}`} className="flex flex-col gap-s2">
            {first.rows.map((row) => {
              const state = recency(row.lastEventAt, now);
              return (
                <li key={`${row.machineId}:${row.agent ?? ''}`} className="flex items-center gap-s2 t-small text-ink-2" data-capture-row="">
                  <HealthDot tone={state.tone} live={state.live} label={state.label} />
                  <span className="min-w-0 flex-1 truncate">{agentName(row.agent)}</span>
                  <span className="shrink-0 text-muted">{ago(row.lastEventAt, now)}</span>
                </li>
              );
            })}
          </ul>
          {others.length > 0 && (
            <ul aria-label="Other machines" className="flex flex-col gap-s1 border-t border-line pt-s3">
              {others.map((group) => {
                const latest = group.rows[0]!;
                return (
                  <li key={group.machineId} className="t-small text-muted" data-capture-row="">
                    <span className="text-ink-2">{group.name}</span> · {group.rows.map((row) => agentName(row.agent)).join(', ')}, {ago(latest.lastEventAt, now)}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
