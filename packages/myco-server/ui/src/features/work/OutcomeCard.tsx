import { type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ActionLink, Disclosure, focusRing, ItemLink, StatusChip, TypeChip } from '../../design';
import { cn } from '../../lib/cn';
import { count, failureNextStep } from '../today/words';
import type { FailureGroup, KindSummary } from './outcomes';
import { failureDetail, failureWords, runNoun } from './words';

export interface OutcomeCardProps {
  kind: KindSummary['kind'];
  headline: string;
  /** One line under the headline: how many runs, and when the latest was. */
  meta: ReactNode;
  /** An action beside the headline, as the code map's "Update now". */
  action?: ReactNode;
  /** The failure had nothing to show: the card's tone is a failure's. */
  failed?: boolean;
  children?: ReactNode;
}

/** One kind of Myco's work as what came of it: the headline, its evidence, its runs, and any failure beside it. */
export function OutcomeCard({ kind, headline, meta, action, failed = false, children }: OutcomeCardProps) {
  const id = `outcome-${kind}`;
  return (
    <article aria-labelledby={id} data-outcome={kind} className="flex min-w-0 flex-col gap-s4 rounded-card border border-line bg-surface-1 p-s4 sm:p-s5">
      <header className="flex flex-wrap items-start justify-between gap-x-s4 gap-y-s2">
        <div className="flex min-w-0 flex-1 flex-col gap-s1">
          <h2 id={id} className={cn('t-h3', failed ? 'text-bad' : 'text-ink')}>{headline}</h2>
          <p className="t-small text-muted">{meta}</p>
        </div>
        {action}
      </header>
      {children}
    </article>
  );
}

/** A small label over a part of a card, with an optional count or link at its end. */
export function PartLabel({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-s3">
      <h3 className="t-kicker text-faint">{children}</h3>
      {end != null && <span className="t-small text-muted">{end}</span>}
    </div>
  );
}

/** A line of evidence: a spore's line with its type, or a session's title. */
export interface EvidenceLine {
  key: string;
  chip?: string;
  text: string;
  /** A second, quieter line: an agent and a time. */
  detail?: string;
  to?: string;
}

/** The lines an outcome shows as its evidence, and "and N more" past them. */
export function EvidenceLines({ label, lines, more }: { label: string; lines: readonly EvidenceLine[]; more: number }) {
  if (lines.length === 0 && more <= 0) return null;
  return (
    <ul aria-label={label} className="flex flex-col gap-s2">
      {lines.map((line) => (
        <li key={line.key} className="flex min-w-0 items-baseline gap-s3 t-small text-ink-2">
          {line.chip !== undefined && <TypeChip className="shrink-0">{line.chip}</TypeChip>}
          <span className="flex min-w-0 flex-col">
            {line.to === undefined ? <span className="line-clamp-2">{line.text}</span> : <ItemLink to={line.to}>{line.text}</ItemLink>}
            {line.detail !== undefined && <span className="t-meta text-muted">{line.detail}</span>}
          </span>
        </li>
      ))}
      {more > 0 && <li className="t-small text-muted">and {more.toLocaleString()} more</li>}
    </ul>
  );
}

/** A link that reads as ink, underlined on hover: a record's headline. */
export function InkLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <RouterLink to={to} className={cn('rounded-chip hover:underline hover:decoration-line-strong hover:underline-offset-3', focusRing)}>
      {children}
    </RouterLink>
  );
}

/** A link onward, in the link colour with an arrow: "See all 180 spores →". */
export function OnwardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <ActionLink to={to}>
      {children} →
    </ActionLink>
  );
}

/** One run in an outcome's list. */
export interface RunLineItem {
  key: string;
  time: string;
  /** The instant `time` names. */
  at: number;
  words: string;
  model?: ReactNode;
  /** The machine it ran on, or the project across projects. */
  where: string | null;
  /** "by Ada" for a run a member started. */
  by: string | null;
  tone: 'plain' | 'bad' | 'held' | 'live';
  to: string;
}

const TONE_CHIP: Readonly<Record<RunLineItem['tone'], { tone: 'ok' | 'warn' | 'bad' | 'neutral'; word: string } | null>> = {
  plain: null,
  bad: { tone: 'bad', word: 'Failed' },
  // A held-off run's own words start "Held off:", so a chip would say it twice.
  held: null,
  live: { tone: 'ok', word: 'Now' },
};

/** An outcome's latest runs, each opening its panel. */
export function RunLines({ label, items, state }: { label: string; items: readonly RunLineItem[]; state?: unknown }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line rounded-control border border-line">
      {items.map((item) => {
        const chip = TONE_CHIP[item.tone];
        return (
          <li key={item.key} className="relative flex min-h-row-tight items-center gap-s3 px-s3 py-s2 transition-colors duration-120 hover:bg-surface-2" data-run-line={item.tone}>
            {/* On a phone the day sits above the time, so the column stays narrow and the words get the room. */}
            <time dateTime={new Date(item.at).toISOString()} className="flex w-s12 shrink-0 flex-col t-small tabular-nums text-faint sm:w-time-col sm:flex-row sm:gap-s1">
              {item.time.split(' ').map((part) => <span key={part} className="whitespace-nowrap">{part}</span>)}
            </time>
            <span className="flex min-w-0 flex-1 flex-col gap-s1">
              <RouterLink
                to={item.to}
                state={state}
                className={cn('min-w-0 break-words rounded-chip t-small text-ink-2 after:absolute after:inset-0', item.tone === 'held' && 'text-muted', focusRing)}
              >
                {item.words}
              </RouterLink>
              {item.model}
              {(item.where !== null || item.by !== null) && (
                <span className="truncate t-meta text-muted sm:ml-auto">{[item.where, item.by].filter((part) => part !== null).join(' · ')}</span>
              )}
            </span>
            {chip !== null && <StatusChip tone={chip.tone} className="shrink-0">{chip.word}</StatusChip>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One project's failed runs of one kind that kept nothing, written beside
 * their outcome: when, on what, why, and what to do. It reads as answered only
 * when a later run of the same kind in the same project produced something.
 */
export function FailureBlock({ kind, group, window, where, when, machineOf, openTo }: {
  kind: KindSummary['kind'];
  group: FailureGroup;
  /** "this week" or "today". */
  window: string;
  /** The project's name across projects, or null under one project. */
  where: string | null;
  when: (at: number | null) => string;
  /** Where a listed run ran, as the page may say it, or null. */
  machineOf: (runId: string) => string | null;
  /** Where a run opens. */
  openTo: (projectId: string, runId: string) => string;
}) {
  const { failures, producedSince } = group;
  if (group.count === 0) return null;
  // Failures with the same headline, reason and machine share a line with every time they happened.
  const groups = new Map<string, { cause: string; detail: string | null; times: string[] }>();
  for (const run of failures) {
    const cause = failureWords(run.failure);
    const machine = machineOf(run.id);
    const detail = failureDetail(run.failure);
    const key = `${cause}\u0000${detail ?? ''}\u0000${machine ?? ''}`;
    const line = groups.get(key) ?? { cause: machine === null ? cause : `On ${machine}: ${cause}`, detail, times: [] };
    line.times.push(when(run.at));
    groups.set(key, line);
  }
  const answered = producedSince > 0;
  return (
    <div className={cn('flex flex-col gap-s2 rounded-control border px-s3 py-s3 t-small text-ink-2', answered ? 'border-line bg-surface-2' : 'border-line bg-bad-bg')} data-failure={answered ? 'recovered' : 'open'}>
      <p className={cn('font-medium', answered ? 'text-ink' : 'text-bad')}>
        {count(group.count, runNoun(kind), runNoun(kind, 2))} failed {window}{where === null ? '' : ` in ${where}`}
      </p>
      {failures.length < group.count && <p>Showing {failures.length.toLocaleString()} of {group.count.toLocaleString()} failed runs here. Open the latest attempt or load more run evidence below.</p>}
      {groups.size > 0 && <ul className="flex flex-col gap-s1">
        {[...groups.values()].map((line) => (
          <li key={`${line.cause}${line.detail ?? ''}${line.times.join()}`} className="flex flex-col gap-s1 sm:flex-row sm:gap-s3">
            <span className="shrink-0 tabular-nums text-muted">{listTimes(line.times)}</span>
            <div className="min-w-0">
              <p>{line.cause}</p>
              {line.detail !== null && <Disclosure summary="Details"><p className="whitespace-pre-wrap break-words">{line.detail}</p></Disclosure>}
            </div>
          </li>
        ))}
      </ul>}
      <p>{answered ? `The ${count(producedSince, runNoun(kind), runNoun(kind, 2))} since then worked, so there’s nothing to do.` : failureNextStep(kind, false)}</p>
      <OnwardLink to={openTo(group.projectId, group.latestRunId)}>Open the latest attempt</OnwardLink>
    </div>
  );
}

function listTimes(times: readonly string[]): string {
  if (times.length <= 1) return times[0] ?? '';
  if (times.length <= 3) return `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
  return `${times.slice(0, 2).join(', ')} and ${times.length - 2} more`;
}

/** Full-window count of runs that stopped after saving output, with a cause only when its run is listed. */
export function KeptNote({ summary }: { summary: Pick<KindSummary, 'kind' | 'failedWithOutput' | 'kept'> }) {
  const { kind, kept, failedWithOutput } = summary;
  if (failedWithOutput === 0) return null;
  const one = failedWithOutput === 1;
  const cause = one && kept.length === 1 ? failureWords(kept[0]!.failure) : null;
  const why = cause === null ? null : cause.trim().replace(/\.$/, '');
  const saved = {
    learn: 'spores saved from recent sessions',
    title: 'session titles and summaries written',
    map: 'code map updates written',
    seed: 'spores saved from the project’s code',
  }[kind];
  return (
    <p className="rounded-control border border-line bg-surface-2 px-s3 py-s2 t-small text-ink-2" data-kept="">
      {one ? 'One' : failedWithOutput.toLocaleString()} {runNoun(kind, failedWithOutput)} stopped early{why === null || why === '' ? '.' : <>: {why.charAt(0).toLowerCase()}{why.slice(1)}.</>}{' '}
      The {saved} are kept.
    </p>
  );
}
