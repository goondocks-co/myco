import { Fragment, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { focusRing, HealthDot } from '../../design';
import { cn } from '../../lib/cn';
import type { LedeCounts } from './timeline';
import type { Upkeep } from './wire';
import { ago, count, when } from './words';

type Part = string | { strong: string };

/** The lede's sentence as parts, the numbers and names marked strong. `projectName` answers null for a Project it does not know. */
export function ledeParts(counts: LedeCounts, options: { isToday: boolean; scoped: boolean; projectName: (projectId: string) => string | null }): Part[] {
  const name = (projectId: string) => options.projectName(projectId) ?? 'a project';
  const where = (projects: readonly string[]): Part[] => {
    if (options.scoped || projects.length === 0) return [];
    if (projects.length <= 2) return [' in ', ...joinStrong(projects.map(name))];
    return [' in ', { strong: count(projects.length, 'project') }];
  };
  const parts: Part[] = [];
  if (options.isToday && counts.liveProjects.length > 0) {
    parts.push(counts.liveProjects.length === 1 ? 'An agent is working' : 'Agents are working');
    parts.push(...(options.scoped ? [] : where(counts.liveProjects)), ' right now. ');
  }
  const day = options.isToday ? 'Today y' : 'Y';
  if (counts.sessions > 0) {
    parts.push(`${day}our agents ran `, { strong: count(counts.sessions, 'session') }, ...where(counts.sessionProjects));
    if (counts.spores > 0) parts.push(', and Myco learned ', { strong: count(counts.spores, 'spore') }, ...where(counts.sporeProjects));
    parts.push('.');
  } else if (counts.spores > 0) {
    parts.push(`${day}our agents ran no sessions, and Myco learned `, { strong: count(counts.spores, 'spore') }, ...where(counts.sporeProjects), '.');
  } else {
    parts.push(`${day}our agents ran no sessions.`);
  }
  return parts;
}

function joinStrong(names: readonly string[]): Part[] {
  const out: Part[] = [];
  names.forEach((n, i) => {
    if (i > 0) out.push(i === names.length - 1 ? ' and ' : ', ');
    out.push({ strong: n });
  });
  return out;
}

/** The sentence under the day's heading: who is working now, and what the day held. */
export function Lede({ parts }: { parts: readonly Part[] }) {
  return (
    <p className="max-w-measure t-body text-ink-2 sm:text-[17px]" data-lede="">
      {parts.map((part, i) => (typeof part === 'string'
        ? <Fragment key={i}>{part}</Fragment>
        : <strong key={i} className="font-semibold text-ink">{part.strong}</strong>))}
    </p>
  );
}

/** The search index's upkeep in one quiet line, or nothing when it has never run. */
export function UpkeepLine({ upkeep, now, statusHref }: { upkeep: Upkeep; now: number; statusHref: string | null }) {
  let content: ReactNode;
  if (upkeep.unrecovered !== null) {
    content = (
      <>
        <HealthDot tone="warn" label="Falling behind" className="translate-y-[-1px]" />
        <span>Search updates have failed since {when(upkeep.unrecovered.since, now).replace(/^at /, '')}; search still answers.</span>
      </>
    );
  } else if (upkeep.lastSuccessAt !== null) {
    const retries = upkeep.failedInWindow;
    content = (
      <>
        <HealthDot tone="ok" label="Up to date" className="translate-y-[-1px]" />
        <span>
          Search kept up to date · {ago(upkeep.lastSuccessAt, now)}
          {retries > 0 && ` · ${count(retries, 'retry', 'retries')} along the way`}
        </span>
      </>
    );
  } else {
    return null;
  }
  return (
    <p className="flex items-baseline gap-s2 t-small text-muted" data-upkeep="">
      {content}
      {statusHref !== null && (
        <RouterLink to={statusHref} className={cn('shrink-0 rounded-chip font-medium text-primary hover:underline', focusRing)}>Status →</RouterLink>
      )}
    </p>
  );
}
