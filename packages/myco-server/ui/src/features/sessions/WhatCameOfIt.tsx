import { ActionLink, Card, ItemLink, StatusChip } from '../../design';
import { whenWithTime } from '../today/words';
import type { SessionOutcome, SessionRun } from './wire';
import { count, readWords, runHeadline, runProgress } from './words';

export interface WhatCameOfItProps {
  projectId: string;
  outcome: SessionOutcome;
  /** Whether the session is still open: Myco learns from a session once it ends. */
  open: boolean;
  now: number;
  /** Where the spore count leads: the session's Spores tab. */
  sporesHref: string;
}


/**
 * What came of a session: how many spores were written from it, one link from
 * the Spores tab that lists them, and the runs of Myco's that read it or wrote
 * from it. A run the Deployment holds no record of reading the session says so;
 * it never reads as a run that read nothing.
 */
export function WhatCameOfIt({ projectId, outcome, open, now, sporesHref }: WhatCameOfItProps) {
  const { runs, spores } = outcome;
  const project = `/p/${encodeURIComponent(projectId)}`;
  const empty = runs.length === 0 && spores.total === 0;
  return (
    <Card data-outcome="" className="flex flex-col gap-s3">
      <h2 className="t-h3 text-ink">What came of it</h2>
      {empty && (
        <p className="t-small text-muted" data-outcome-empty="">
          {open ? 'Nothing yet. Myco learns from a session once it ends.' : 'Nothing yet. Myco hasn’t learned anything from this session.'}
        </p>
      )}
      {spores.total > 0 && <ActionLink to={sporesHref}>{count(spores.total, 'spore')} from this session →</ActionLink>}
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
        <ItemLink to={`${project}/work/runs/${encodeURIComponent(run.runId)}`} className="text-ink-2 hover:text-ink">{runHeadline(run)}</ItemLink>
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

