import { useParams } from 'react-router-dom';
import { Breadcrumbs, Card, ErrorState, HealthDot, ListRow, ShowMore, StatusChip, type HealthTone } from '../../../design';
import { usePaged, type Page } from '../../../hooks/use-paged';
import { formatRelative } from '../../../lib/format';
import { RUNNERS_PATH, runPath } from '../../../routes/nav';
import { atWords } from '../../work/words';
import { SourceMark } from '../../work/RunStory';
import { AdminPage, AdminSection } from '../AdminFrame';
import { taskWords } from '../workers';
import { agentVersionWords, modelDrift, runnerVersionWords, type DriftFacts } from './drift';

/** How one claim by this runner came out, as `GET /api/runners/{id}/runs` answers it. */
type RunnerRunOutcome = 'running' | 'worked' | 'changed_nothing' | 'failed' | 'handed_on' | 'other';
interface RunnerRun extends DriftFacts { attemptId: string; claimedAt: number; projectId: string; projectName: string | null; runId: string; task: string | null; completedAt: number | null; outcome: RunnerRunOutcome }
interface RunnerRunsPage extends Page<RunnerRun> {
  runner: { id: string; name: string; state: string; lastSeenAt: number | null; version: string | null };
}

const OUTCOME_WORDS: Readonly<Record<RunnerRunOutcome, { words: string; tone: HealthTone }>> = {
  running: { words: 'Running now', tone: 'ok' },
  worked: { words: 'Worked', tone: 'ok' },
  changed_nothing: { words: 'Worked; changed nothing', tone: 'ok' },
  failed: { words: 'Failed', tone: 'bad' },
  handed_on: { words: 'Stopped here; another try took it on', tone: 'warn' },
  other: { words: 'Ended', tone: 'faint' },
};

/** One claim on the page: an attempt id is the claiming credential's, so the run names the claim. */
const runKey = (run: RunnerRun): string => `${run.projectId}\u0000${run.runId}\u0000${run.attemptId}`;

/** "N of the last M finished runs worked", over the runs the page has loaded. */
export function workedWords(rows: readonly Pick<RunnerRun, 'outcome'>[]): string | null {
  const finished = rows.filter((row) => row.outcome === 'worked' || row.outcome === 'changed_nothing' || row.outcome === 'failed');
  if (finished.length === 0) return null;
  const worked = finished.filter((row) => row.outcome !== 'failed').length;
  return `${worked.toLocaleString()} of the last ${finished.length.toLocaleString()} finished runs worked`;
}

/** One runner's own page: when it last checked in, how its recent runs went, and each run, newest first, across every project. */
export function RunnerPage() {
  const runnerId = useParams().runnerId ?? '';
  const now = Date.now();
  const runs = usePaged<RunnerRun, RunnerRunsPage>(['runners', runnerId, 'runs'], `/api/runners/${encodeURIComponent(runnerId)}/runs`, { freshness: { follows: ['fleet', 'runs'] }, rowKey: runKey });
  const runner = runs.pages?.[0]?.runner;
  const worked = workedWords(runs.rows);
  return (
    <AdminPage name="runner" scope="server" title={runner?.name ?? 'Runner'} lede="What this runner ran, newest first, across every project.">
      <Breadcrumbs items={[{ label: 'Runners', to: `${RUNNERS_PATH}#runner-${encodeURIComponent(runnerId)}` }]} />
      {runs.error !== null && <ErrorState error={runs.error} onRetry={runs.retry}><p>This runner’s runs are unavailable.</p></ErrorState>}
      {runs.isPending && runs.error === null && <p className="t-body text-muted">Loading this runner’s runs…</p>}
      {runner !== undefined && (
        <Card className="flex flex-col gap-s2" data-runner-facts="">
          <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1 t-body text-ink">
            {runner.lastSeenAt === null ? 'Has not checked in yet' : `Last checked in ${formatRelative(runner.lastSeenAt, now)}`}
            <SourceMark source={runner.lastSeenAt === null ? 'none' : 'saw'} />
            {runner.state !== 'enabled' && <StatusChip tone="neutral">{runner.state === 'paused' ? 'Paused' : 'Removed'}</StatusChip>}
          </p>
          {worked !== null && <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1 t-small text-ink-2" data-runner-worked="">{worked}<SourceMark source="saw" /></p>}
          {runner.version !== null && <p className="t-meta text-muted">Runner version {runner.version}, as it last reported.</p>}
        </Card>
      )}
      {runs.rows.length > 0 && <RunnerDrift rows={runs.rows} />}
      <AdminSection id="runner-runs" title="Recent runs" description="Each time this runner took a run, with how that run came out. A run another try took on later shows here where this runner stopped.">
        {runner !== undefined && runs.rows.length === 0 && <p className="t-body text-muted">This runner has not run anything yet.</p>}
        <ul className="flex flex-col">
          {runs.rows.map((run) => {
            const outcome = OUTCOME_WORDS[run.outcome];
            return (
              <li key={runKey(run)} data-runner-run={run.outcome}>
                <ListRow
                  to={runPath(run.projectId, run.runId)}
                  leading={<HealthDot tone={outcome.tone} label={outcome.words} />}
                  title={`${taskWords(run.task).charAt(0).toUpperCase()}${taskWords(run.task).slice(1)}${run.projectName === null ? '' : ` · ${run.projectName}`}`}
                  meta={`${outcome.words} · started ${atWords(run.claimedAt, now)}`}
                  wrap
                />
              </li>
            );
          })}
        </ul>
        {runs.rows.length > 0 && <ShowMore shown={runs.rows.length} noun="runs" onMore={runs.more} pending={runs.isFetchingMore} hasMore={runs.hasMore} />}
      </AdminSection>
    </AdminPage>
  );
}

/** Versions and models across the runs the page has loaded: what each ran with, and the model each ran against what it was asked for. */
function RunnerDrift({ rows }: { rows: readonly RunnerRun[] }) {
  const runner = runnerVersionWords(rows);
  const agents = agentVersionWords(rows);
  const models = modelDrift(rows);
  return (
    <AdminSection id="runner-drift" title="What its runs ran with" description={`Across the ${rows.length.toLocaleString()} runs shown below: the versions each ran with, and the model each ran against the one it was asked for.`}>
      <Card className="flex flex-col gap-s2" data-runner-drift="">
        {runner !== null && <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1 t-small text-ink-2" data-drift="runner">Runner: {runner}<SourceMark source="runner" /></p>}
        {agents !== null && <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1 t-small text-ink-2" data-drift="agent">Agents: {agents}<SourceMark source="runner" /></p>}
        {models.headline !== null && <p className="flex flex-wrap items-baseline gap-x-s2 gap-y-s1 t-small text-ink-2" data-drift="models">{models.headline}<SourceMark source="runner" /></p>}
        {models.lines.length > 0 && (
          <ul className="flex flex-col gap-s1 t-meta" aria-label="Models asked for and run">
            {models.lines.map((line) => <li key={line.words} className={line.state === 'mismatch' ? 'text-warn' : 'text-muted'} data-model-drift={line.state}>{line.words}</li>)}
          </ul>
        )}
        <p className="t-meta text-muted">Versions are as the runner reported them when it took each run; a runner from before Myco recorded them reads “not reported”. Models are as each run’s latest try recorded them: the model its agent reported, or only the one it was launched with where it reported none.</p>
      </Card>
    </AdminSection>
  );
}
