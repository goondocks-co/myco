import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, ErrorState, FilterPills, HealthDot, Link, ListRow, Select, ShowMore, Sparkline, StackedBars, type HealthTone } from '../../design';
import { usePaged, type Page } from '../../hooks/use-paged';
import { useProjects } from '../../hooks/use-projects';
import { fetchJson } from '../../lib/api';
import { harnessLabel } from '../../lib/harness';
import { live } from '../../lib/live';
import { runPath, runnerPath } from '../../routes/nav';
import { AdminPage, AdminSection } from '../admin/AdminFrame';
import { taskWords } from '../admin/workers';
import { runErrorWords, shortTime } from '../work/words';
import { gapsOf, slicesOf, type RunsWindow } from './timeline';

type Outcome = 'worked' | 'unchanged' | 'failed';
interface Counts { worked: number; unchanged: number; failed: number }
type Dimension = 'cause' | 'runner' | 'agent' | 'task';
interface FailureGroup { key: string | null; name: string | null; runs: number; prior: number; slices: number[]; latestHour: number | null }
/** `GET /api/runs/hours`: runs finished per runner and hour, and failures grouped with the window before. */
export interface RunHoursAnswer {
  window: { name: RunsWindow; since: number; until: number; sliceMs: number };
  counted: boolean;
  totals: Counts & { waitedMs: number };
  lanes: { runnerId: string | null; name: string | null; hours: (Counts & { hour: number })[] }[];
  failures: Record<Dimension, FailureGroup[]>;
}
/** One run of `GET /api/runs/finished`. */
interface FinishedRun {
  projectId: string; projectName: string | null; runId: string; task: string | null; result: 'produced' | 'unchanged' | 'failed' | 'failed_with_output';
  errorCode: string | null; harness: string | null; model: string | null; runner: { id: string; name: string | null } | null; completedAt: number;
}

const WINDOW_WORDS: Readonly<Record<RunsWindow, { pill: string; span: string; before: string }>> = {
  day: { pill: 'Last 24 hours', span: 'in the last 24 hours', before: 'the day before' },
  week: { pill: 'Last 7 days', span: 'in the last 7 days', before: 'the week before' },
};
const OUTCOME_WORDS: Readonly<Record<Outcome, { words: string; tone: HealthTone }>> = {
  worked: { words: 'Worked', tone: 'ok' }, unchanged: { words: 'Changed nothing', tone: 'faint' }, failed: { words: 'Failed', tone: 'bad' },
};
const outcomeOf = (result: FinishedRun['result']): Outcome => result === 'produced' ? 'worked' : result === 'unchanged' ? 'unchanged' : 'failed';
/** Each grouping, the parameter that narrows the runs to one of its values, and the one that narrows them to runs that recorded none. */
const DIMENSIONS: ReadonlyArray<{ value: Dimension; label: string; param: string; none: string }> = [
  { value: 'cause', label: 'Cause', param: 'cause', none: 'noCause' }, { value: 'runner', label: 'Runner', param: 'runner', none: 'noRunner' },
  { value: 'agent', label: 'Agent', param: 'agent', none: 'noAgent' }, { value: 'task', label: 'Task', param: 'task', none: 'noTask' },
];
/** The query parameters that narrow the list of runs, in the order the list names them. */
const FILTERS = ['outcome', ...DIMENSIONS.flatMap((d) => [d.param, d.none])];
/** The project choice that reads every project: `*` is never a project id's character. */
const ALL_PROJECTS = '*';
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

/** A failure group's name in the reader's words. */
function groupWords(dimension: Dimension, group: Pick<FailureGroup, 'key' | 'name'>): string {
  if (group.key === null) return dimension === 'runner' ? 'No runner' : dimension === 'agent' ? 'No agent recorded' : dimension === 'task' ? 'A task' : 'No reason recorded';
  if (dimension === 'cause') return runErrorWords(group.key);
  if (dimension === 'runner') return group.name ?? 'A runner no longer registered';
  if (dimension === 'agent') return harnessLabel(group.key);
  return capital(taskWords(group.key));
}

/** How a group's failures compare with the window before: new, up, down or the same. */
function trendWords(group: FailureGroup, before: string): string {
  if (group.runs === 0) return `None now; ${group.prior.toLocaleString()} ${before}`;
  if (group.prior === 0) return `New: none ${before}`;
  if (group.runs === group.prior) return `As many as ${before}`;
  return `${group.runs > group.prior ? 'Up' : 'Down'} from ${group.prior.toLocaleString()} ${before}`;
}

/**
 * Runs: every run Myco's work finished across projects (or one), when and on which runner, what failed grouped by cause,
 * runner, agent or task with a trend, and the runs themselves, narrowed by any of those and opening each run's panel.
 */
export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const window: RunsWindow = params.get('window') === 'week' ? 'week' : 'day';
  const projectId = params.get('project');
  const dimension = DIMENSIONS.find((d) => d.value === params.get('group'))?.value ?? 'cause';
  const now = Date.now();
  const scope = new URLSearchParams({ window, ...(projectId === null ? {} : { project: projectId }) });
  const freshness = window === 'day' ? { follows: ['runs'] as const } : 'heavy' as const;
  const hours = useQuery({
    queryKey: ['runs', 'hours', window, projectId],
    queryFn: ({ signal }) => fetchJson<RunHoursAnswer>(`/api/runs/hours?${scope}`, signal),
    ...live<RunHoursAnswer>(freshness),
  });
  const filtered = new URLSearchParams(scope);
  for (const key of FILTERS) { const value = params.get(key); if (value !== null) filtered.set(key, value); }
  const runs = usePaged<FinishedRun, Page<FinishedRun>>(['runs', 'finished', filtered.toString()], `/api/runs/finished?${filtered}`, { freshness, rowKey: (run) => `${run.projectId}\u0000${run.runId}` });
  const projects = useProjects().data?.projects.filter((project) => project.archivedAt == null) ?? [];
  const set = (changes: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(changes)) if (value === null) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });
  const words = WINDOW_WORDS[window];
  const answer = hours.data;
  return (
    <AdminPage name="runs" title="Runs" lede="Every run Myco’s work finished: when, on which runner, and what failed."
      actions={<>
        <Select label="Project" value={projectId ?? ALL_PROJECTS} onValueChange={(value) => set({ project: value === ALL_PROJECTS ? null : value })}
          options={[{ value: ALL_PROJECTS, label: 'All projects' }, ...projects.map((project) => ({ value: project.projectId, label: project.name ?? project.projectId }))]} />
        <FilterPills label="Window" value={window} onChange={(value) => set({ window: value === 'day' ? null : value })}
          options={(['day', 'week'] as const).map((value) => ({ value, label: WINDOW_WORDS[value].pill }))} />
      </>}>
      {hours.error !== null && <ErrorState error={hours.error} onRetry={() => void hours.refetch()}><p>When runs finished is unavailable.</p></ErrorState>}
      {hours.isPending && <p className="t-body text-muted">Loading runs…</p>}
      {answer !== undefined && (
        <>
          <AdminSection id="runs-timeline" title="When runs finished" description={window === 'day' ? 'Each runner’s runs by the hour. An empty hour is one where nothing finished on that runner.' : 'Each runner’s runs by the day. An empty day is one where nothing finished on that runner.'}>
            <Timeline answer={answer} now={now} span={words.span} />
          </AdminSection>
          <AdminSection id="runs-failing" title="What’s failing" description={`Failed runs ${words.span}, grouped, beside ${words.before}. Open a group to see its runs.`}
            actions={<FilterPills label="Group by" value={dimension} onChange={(value) => set({ group: value === 'cause' ? null : value })} options={DIMENSIONS} />}>
            <Failures groups={answer.failures[dimension]} dimension={dimension} before={words.before} openWith={(key) => {
              const { param, none } = DIMENSIONS.find((d) => d.value === dimension)!;
              const next = new URLSearchParams(params);
              next.set('outcome', 'failed');
              next.delete(key === null ? param : none);
              if (key === null) next.set(none, '1'); else next.set(param, key);
              return `?${next}#runs-all`;
            }} />
          </AdminSection>
        </>
      )}
      <AdminSection id="runs-all" title="All runs" description={`The runs that finished ${words.span}, newest first.`}>
        <div className="flex flex-wrap items-center gap-s2">
          <div className="w-full sm:w-auto">
            <FilterPills label="Outcome" value={(params.get('outcome') as Outcome | null) ?? 'any'} onChange={(value) => set({ outcome: value === 'any' ? null : value })}
              options={[{ value: 'any', label: 'Everything' }, ...(['worked', 'unchanged', 'failed'] as const).map((value) => ({ value, label: OUTCOME_WORDS[value].words }))]} />
          </div>
          {DIMENSIONS.map(({ value: dim, param, none }) => {
            const value = params.get(param);
            if (value === null && params.get(none) === null) return null;
            const name = dim === 'runner' && value !== null ? answer?.lanes.find((lane) => lane.runnerId === value)?.name ?? null : null;
            return <Button key={param} size="sm" variant="secondary" onClick={() => set({ [param]: null, [none]: null })} data-runs-filter={param}>{groupWords(dim, { key: value, name })} ×</Button>;
          })}
        </div>
        {runs.error !== null && <ErrorState error={runs.error} onRetry={runs.retry}><p>The list of runs is unavailable.</p></ErrorState>}
        {!runs.isPending && runs.error === null && runs.rows.length === 0 && !runs.hasMore && <p className="t-body text-muted">No run finished {words.span} that matches.</p>}
        {runs.error === null && runs.rows.length === 0 && runs.hasMore && (
          <div className="flex flex-wrap items-center gap-s3" data-runs-keep-looking="">
            <p className="t-body text-muted">None found yet among the runs checked so far.</p>
            <Button size="sm" variant="secondary" onClick={runs.more} pending={runs.isFetchingMore}>Keep looking</Button>
          </div>
        )}
        <ul className="flex flex-col">
          {runs.rows.map((run) => {
            const outcome = OUTCOME_WORDS[outcomeOf(run.result)];
            return (
              <li key={`${run.projectId}\u0000${run.runId}`} className="flex items-center" data-runs-run={outcomeOf(run.result)}>
                <ListRow className="flex-1" to={runPath(run.projectId, run.runId)} leading={<HealthDot tone={outcome.tone} label={outcome.words} />}
                  title={`${capital(taskWords(run.task))}${run.projectName === null ? '' : ` · ${run.projectName}`}`}
                  meta={[outcome.words, run.errorCode === null || outcomeOf(run.result) !== 'failed' ? null : runErrorWords(run.errorCode), run.harness === null ? null : harnessLabel(run.harness), `finished ${shortTime(run.completedAt, now)}`].filter((part) => part !== null).join(' · ')} wrap />
                {run.runner !== null && <Link to={runnerPath(run.runner.id)} className="shrink-0 px-s3 t-small">{run.runner.name ?? 'Its runner'}</Link>}
              </li>
            );
          })}
        </ul>
        {runs.rows.length > 0 && <ShowMore shown={runs.rows.length} noun="runs" onMore={runs.more} pending={runs.isFetchingMore} hasMore={runs.hasMore} />}
      </AdminSection>
    </AdminPage>
  );
}

/** Each runner's lane of finished runs per slice, the empty slices left visible, then the spells when nothing finished anywhere. */
function Timeline({ answer, now, span }: { answer: RunHoursAnswer; now: number; span: string }) {
  const { totals } = answer;
  const finished = totals.worked + totals.unchanged + totals.failed;
  const gaps = gapsOf(answer, now);
  return (
    <Card className="flex flex-col gap-s3">
      {!answer.counted && <p className="t-small text-muted" data-runs-counting="">Myco is still counting runs that finished before this page existed, so earlier hours may read low.</p>}
      <p className="t-body text-ink" data-runs-totals="">{finished === 0 ? `Nothing finished ${span}.`
        : `${count(finished, 'run')} finished ${span}: ${totals.worked.toLocaleString()} worked, ${totals.unchanged.toLocaleString()} changed nothing, ${totals.failed.toLocaleString()} failed.`}</p>
      <ul className="flex flex-col gap-s2">
        {answer.lanes.map((lane) => {
          const slices = slicesOf(answer, lane);
          const empty = slices.filter((slice) => slice.worked + slice.unchanged + slice.failed === 0).length;
          const sum = (key: keyof Counts) => slices.reduce((n, slice) => n + slice[key], 0);
          const label = `${lane.name ?? 'No runner'}: ${sum('worked')} worked, ${sum('unchanged')} changed nothing, ${sum('failed')} failed; nothing finished in ${empty} of ${slices.length}`;
          return (
            <li key={lane.runnerId ?? ''} className="flex flex-col gap-s1" data-runs-lane={lane.name ?? ''}>
              {lane.runnerId === null ? <span className="t-small text-ink-2">Runs no runner ran</span>
                : <Link to={runnerPath(lane.runnerId)} className="t-small">{lane.name ?? 'A runner no longer registered'}</Link>}
              <StackedBars label={label} slots={slices.map((slice) => ({ parts: [{ value: slice.worked, tone: 'ok' }, { value: slice.unchanged, tone: 'faint' }, { value: slice.failed, tone: 'bad' }] }))} />
            </li>
          );
        })}
      </ul>
      {gaps.length > 0 && <ul className="flex flex-col gap-s1 t-small text-ink-2" data-runs-gaps="">{gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
      <p className="t-meta text-muted">Green worked, grey changed nothing, red failed. Hatched: nothing finished.</p>
    </Card>
  );
}

function Failures({ groups, dimension, before, openWith }: { groups: FailureGroup[]; dimension: Dimension; before: string; openWith: (key: string | null) => string }) {
  if (groups.length === 0) return <p className="t-body text-muted" data-runs-failing="none">Nothing failed here, nor {before}.</p>;
  return (
    <Card className="p-0">
      <ul className="flex flex-col">
        {groups.map((group) => (
          <li key={group.key ?? ''} data-runs-group={group.key ?? ''}>
            <ListRow to={openWith(group.key)} leading={<HealthDot tone={group.runs === 0 ? 'faint' : 'bad'} label={group.runs === 0 ? 'Quiet now' : 'Failing'} />}
              title={groupWords(dimension, group)}
              meta={`${count(group.runs, 'failed run')} · ${trendWords(group, before)}${dimension === 'cause' && group.key !== null ? ` · recorded as ${group.key}` : ''}`}
              trailing={<Sparkline data={group.slices} label={`${count(group.runs, 'failed run')}, oldest first`} />} wrap />
          </li>
        ))}
      </ul>
    </Card>
  );
}
