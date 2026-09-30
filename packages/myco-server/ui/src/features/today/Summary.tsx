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
  // A place is said once: the spores' projects, when they are the ones already named, go unsaid.
  const said = new Set<string>();
  const once = (projects: readonly string[]): Part[] => {
    const key = [...projects].sort().join(',');
    if (said.has(key)) return [];
    said.add(key);
    return where(projects);
  };
  const parts: Part[] = [];
  if (options.isToday && counts.liveProjects.length > 0) {
    parts.push(counts.liveProjects.length === 1 ? 'An agent is working' : 'Agents are working');
    parts.push(...once(counts.liveProjects), ' right now. ');
  }
  const day = options.isToday ? 'Today y' : 'Y';
  if (counts.sessions > 0) {
    parts.push(`${day}our agents ran `, { strong: count(counts.sessions, 'session') }, ...once(counts.sessionProjects));
    if (counts.spores > 0) parts.push(', and Myco learned ', { strong: count(counts.spores, 'spore') }, ...once(counts.sporeProjects));
    parts.push('.');
  } else if (counts.spores > 0) {
    parts.push(`${day}our agents ran no sessions, and Myco learned `, { strong: count(counts.spores, 'spore') }, ...once(counts.sporeProjects), '.');
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

/** The search index's upkeep in one quiet line, or nothing when it has never run; Health, for an admin, ends the line. */
export function UpkeepLine({ upkeep, now, statusHref }: { upkeep: Upkeep; now: number; statusHref: string | null }) {
  let dot: ReactNode;
  let words: string;
  if (upkeep.unrecovered !== null) {
    dot = <HealthDot tone="warn" label="Falling behind" />;
    words = `Search updates have failed since ${when(upkeep.unrecovered.since, now).replace(/^at /, '')}; search still answers.`;
  } else if (upkeep.lastSuccessAt !== null) {
    const retries = upkeep.failedInWindow;
    dot = <HealthDot tone="ok" label="Up to date" />;
    words = `Search kept up to date · ${ago(upkeep.lastSuccessAt, now)}${retries > 0 ? ` · ${count(retries, 'retry', 'retries')} along the way` : ''}`;
  } else {
    return null;
  }
  return (
    <p className="flex items-start gap-s2 t-small text-muted" data-upkeep="">
      <span className="flex h-lh shrink-0 items-center">{dot}</span>
      <span>
        {words}
        {statusHref !== null && (
          <>
            {' · '}
            <RouterLink to={statusHref} className={cn('whitespace-nowrap rounded-chip font-medium text-primary hover:underline', focusRing)}>Health →</RouterLink>
          </>
        )}
      </span>
    </p>
  );
}
