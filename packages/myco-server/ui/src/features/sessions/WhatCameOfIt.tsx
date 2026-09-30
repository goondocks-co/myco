import { Link as RouterLink } from 'react-router-dom';
import { Card, focusRing, StatusChip, TypeChip } from '../../design';
import { cn } from '../../lib/cn';
import { shortDay, whenWithTime } from '../today/words';
import type { SessionOutcome, SessionRun } from './wire';
import { count, readWords, runHeadline, runProgress, sporeLine, sporeTypeWord } from './words';

export interface WhatCameOfItProps {
  projectId: string;
  outcome: SessionOutcome;
  /** Whether the session is still open: Myco learns from a session once it ends. */
  open: boolean;
  now: number;
  /** Where "All N spores" leads: the session's Spores tab. */
  sporesHref: string;
}

const itemLink = cn('rounded-chip text-ink-2 hover:text-ink hover:underline', focusRing);

/**
 * What came of a session: the spores written from it and the runs of Myco's
 * that read it or wrote from it. A run the Deployment holds no record of
 * reading the session says so; it never reads as a run that read nothing.
 */
export function WhatCameOfIt({ projectId, outcome, open, now, sporesHref }: WhatCameOfItProps) {
  const { runs, spores } = outcome;
  const project = `/p/${encodeURIComponent(projectId)}`;
  const empty = runs.length === 0 && spores.total === 0;
  return (
    <Card data-outcome="" className="flex flex-col gap-s3">
      <div className="flex items-baseline gap-s2">
        <h2 className="t-h3 text-ink">What came of it</h2>
        {spores.total > 0 && <span className="t-small text-muted">{count(spores.total, 'spore')}</span>}
      </div>
      {empty && (
        <p className="t-small text-muted" data-outcome-empty="">
          {open ? 'Nothing yet. Myco learns from a session once it ends.' : 'Nothing yet. Myco hasn’t learned anything from this session.'}
        </p>
      )}
      {spores.items.length > 0 && (
        <ul aria-label="Spores from this session" className="flex flex-col gap-s2">
          {spores.items.map((spore) => (
            <li key={spore.id} className="flex min-w-0 items-baseline gap-s2 t-small">
              <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
              {spore.agentLine !== null && spore.agentLine.trim() !== '' ? (
                <RouterLink to={`${project}/spores/${encodeURIComponent(spore.id)}`} className={cn(itemLink, 'line-clamp-2 min-w-0')}>
                  {sporeLine({ agentLine: spore.agentLine, content: '' })}
                </RouterLink>
              ) : (
                // A spore written without its one line is named by its type and the day it was saved.
                <RouterLink
                  to={`${project}/spores/${encodeURIComponent(spore.id)}`}
                  aria-label={`${sporeTypeWord(spore.observationType)} from ${shortDay(spore.createdAt, now)}`}
                  className={cn(itemLink, 'min-w-0')}
                >
                  {shortDay(spore.createdAt, now)}
                </RouterLink>
              )}
            </li>
          ))}
        </ul>
      )}
      {spores.total > spores.items.length && (
        <RouterLink to={sporesHref} className={cn('w-fit rounded-chip t-small font-medium text-primary hover:underline', focusRing)}>
          All {count(spores.total, 'spore')} →
        </RouterLink>
      )}
      {runs.length > 0 && (
        <ul aria-label="Myco’s work on this session" className="flex flex-col gap-s3 border-t border-line pt-s3">
          {runs.map((run) => <RunLine key={run.runId} run={run} project={project} now={now} />)}
        </ul>
      )}
    </Card>
  );
}

function RunLine({ run, project, now }: { run: SessionRun; project: string; now: number }) {
  const progress = runProgress(run.status);
  const at = run.completedAt ?? run.startedAt;
  const failed = run.status === 'failed';
  return (
    <li className="flex flex-col gap-s1" data-outcome-run={run.readAt === null ? 'unrecorded' : 'read'}>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-s2 t-small font-medium">
        <RouterLink to={`${project}/work/runs/${encodeURIComponent(run.runId)}`} className={itemLink}>{runHeadline(run)}</RouterLink>
        {failed && <StatusChip tone="bad">Failed</StatusChip>}
        {progress !== null && <StatusChip tone="warn">{progress}</StatusChip>}
      </span>
      <span className="t-meta text-muted">
        {readWords(run, (readAt) => whenWithTime(readAt, now))}
        {at !== null && <><span aria-hidden className="mx-s1">·</span>{run.completedAt !== null ? 'finished' : 'started'} {whenWithTime(at, now)}</>}
      </span>
    </li>
  );
}

