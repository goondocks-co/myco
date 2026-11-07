import type { ReactNode } from 'react';
import { Card, HealthDot, ListRow, ReadState, ReadUnavailable, StatusChip, TypeChip } from '../../design';
import { formatElapsed, formatUntil } from '../../lib/format';
import { harnessLabel } from '../../lib/harness';
import { runPath } from '../../routes/nav';
import { displayModel } from '../work/ModelSummary';
import { shortTime } from '../work/words';
import type { NowNeed, NowRunning, NowWaiting, WorkNowAnswer, WorkNowSection } from './wire';

export interface WorkNowProps {
  answer: WorkNowAnswer | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  /** A project's name, for rows of a Deployment-wide answer; null where the dashboard doesn't know it. */
  projectName: (projectId: string) => string | null;
}

/**
 * What Myco is doing now, in three parts: running now, waiting and why, and what needs you. One component for every
 * page that shows it — a project's Myco's work, and Health across every project. Every reason is the server's own
 * sentence (`read/work-now.ts`); this only lays it out.
 */
export function WorkNow({ answer, pending, error, onRetry, now, projectName }: WorkNowProps) {
  return (
    <section aria-label="Myco’s work now" className="flex flex-col gap-s3" data-work-now="">
      <ReadState data={answer} pending={pending} error={error} onRetry={onRetry} label="what Myco is doing now">
        {(data) => {
          const across = data.scope === 'deployment';
          const where = (projectId: string | null): ReactNode => (across && projectId !== null ? <TypeChip>{projectName(projectId) ?? 'A project'}</TypeChip> : null);
          return (
            <div className="flex flex-col gap-s3">
              <Part title="Running now" part="running" data={data} onRetry={onRetry} empty="Nothing is running right now." count={data.running.length}>
                {data.running.map((run) => <RunningRow key={run.runId} run={run} now={now} kicker={where(run.projectId)} />)}
              </Part>
              <Part title="Waiting" part="waiting" data={data} onRetry={onRetry} empty="Nothing is waiting." count={data.waiting.length}>
                {sameWaits(data.waiting).map((group) => <WaitingRow key={group[0]!.key} item={group[0]!} now={now}
                  kicker={group.length === 1 ? where(group[0]!.projectId) : across ? <TypeChip>{group.map((item) => (item.projectId === null ? null : projectName(item.projectId)) ?? 'A project').join(', ')}</TypeChip> : null} />)}
              </Part>
              <Part title="Needs you" part="needsYou" data={data} onRetry={onRetry} empty="Nothing needs you." count={data.needsYou.length} tone="warn">
                {data.needsYou.map((item) => <NeedRow key={item.key} item={item} now={now} kicker={where(item.projectId)} />)}
              </Part>
            </div>
          );
        }}
      </ReadState>
    </section>
  );
}

/** Waits that say the same thing in several projects, side by side as one row: the same work, the same reason, no schedule of its own. */
function sameWaits(items: readonly NowWaiting[]): NowWaiting[][] {
  const groups = new Map<string, NowWaiting[]>();
  for (const item of items) {
    const key = item.nextAt === null && item.count === null ? `${item.what}\u0000${item.why}` : item.key;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

const PART_LABELS: Readonly<Record<WorkNowSection, string>> = { running: 'what is running', waiting: 'what is waiting', needsYou: 'what needs you' };

function Part({ title, part, data, onRetry, empty, count, tone, children }: {
  title: string; part: WorkNowSection; data: WorkNowAnswer; onRetry: () => void; empty: string; count: number; tone?: 'warn'; children: ReactNode;
}) {
  const unavailable = data.unavailable.includes(part);
  return (
    <Card padding="flush" className="flex min-w-0 flex-col" data-now-part={part}>
      <header className="flex items-center justify-between gap-s2 border-b border-line px-s4 py-s2">
        <h2 className="t-h3 text-ink">{title}</h2>
        {count > 0 && <StatusChip tone={tone ?? 'neutral'}>{count}</StatusChip>}
      </header>
      {unavailable ? <div className="p-s4"><ReadUnavailable label={PART_LABELS[part]} onRetry={onRetry} /></div>
        : count === 0 ? <p className="px-s4 py-s3 t-small text-muted" data-now-empty="">{empty}</p>
        : <ul className="flex flex-col">{children}</ul>}
    </Card>
  );
}

function RunningRow({ run, now, kicker }: { run: NowRunning; now: number; kicker: ReactNode }) {
  const ranBy = [run.machine, run.model === null ? (run.harness === null ? null : harnessLabel(run.harness)) : displayModel(run.model)].filter((part) => part !== null).join(' · ');
  return (
    <li data-now-running={run.runId}>
      <ListRow
        to={runPath(run.projectId, run.runId)}
        leading={<HealthDot tone="ok" live label="Running" />}
        kicker={kicker}
        title={<><span>{run.what}</span>{ranBy !== '' && <span className="t-small font-normal text-muted"> · {ranBy}</span>}</>}
        meta={run.step === null ? 'Starting' : `Now: ${run.step.words}`}
        trailing={run.startedAt === null ? undefined : <span>{formatElapsed(Math.max(0, now - run.startedAt))}</span>}
        wrap
      />
    </li>
  );
}

function WaitingRow({ item, now, kicker }: { item: NowWaiting; now: number; kicker: ReactNode }) {
  const when = item.nextAt !== null ? (item.nextAt > now ? `due in ${formatUntil(item.nextAt, now, true)}` : 'due now') : null;
  return (
    <li data-now-waiting={item.key}>
      <ListRow
        leading={<HealthDot tone="faint" label="Waiting" />}
        kicker={kicker}
        title={item.count !== null && item.count > 1 ? `${item.what} (${item.count})` : item.what}
        meta={item.why}
        trailing={when === null ? undefined : <span>{when}</span>}
        wrap
      />
    </li>
  );
}

function NeedRow({ item, now, kicker }: { item: NowNeed; now: number; kicker: ReactNode }) {
  const retry = item.retryAt === null ? '' : item.retryAt > now ? ` Myco tries again at ${shortTime(item.retryAt, now)}.` : ' Myco tries again on its next check.';
  return (
    <li data-now-need={item.key}>
      <ListRow
        to={item.runId === null || item.projectId === null ? undefined : runPath(item.projectId, item.runId)}
        leading={<HealthDot tone="warn" label="Needs you" />}
        kicker={kicker}
        title={item.what}
        meta={`${item.why}${retry}`}
        trailing={item.runId === null || item.projectId === null ? undefined : <span className="hidden whitespace-nowrap text-ink-2 sm:inline">Open run →</span>}
        wrap
      />
    </li>
  );
}

/** Beside a page's title: the page keeps itself current while it is open in view. */
export function LiveMark({ answer }: { answer: WorkNowAnswer | undefined }) {
  if (answer === undefined) return null;
  return <span data-live-mark=""><HealthDot tone="ok" live label="Live" showLabel /></span>;
}
