import { Fragment, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Card, Disclosure, EmptyState, ErrorState, FilterBar, LoadingState, ShowMore, Skeleton, useFilterParams, useQueryDraft, type FilterDefinition,
} from '../../design';
import { useIsAdmin } from '../../hooks/use-me';
import { useNow } from '../../hooks/use-today';
import { useAllTaskRuns, useSessionsById, useTaskRuns, useWindowSpores, useWorkWhileRunning, workHasLiveRun } from '../../hooks/use-work';
import { sessionHeadingText } from '../../lib/session-text';
import {
  CODE_MAP_SUFFIX, HEALTH_ANCHORS, HEALTH_PATH, KNOWLEDGE_SUFFIX, PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath, runPath, WORK_SUFFIX,
} from '../../routes/nav';
import { UpkeepLine } from '../today/Summary';
import type { OutcomeKind, TodaySpore, WorkAnswer, WorkRun } from '../today/wire';
import { agentName, count, sporeLine, sporeTypeWord } from '../today/words';
import { useStarterNames } from './names';
import { costOf, recovered, summarize, type KindSummary } from './outcomes';
import {
  EvidenceLines, FailureBlock, KeptNote, OnwardLink, OutcomeCard, PartLabel, RunLines, type EvidenceLine, type RunLineItem,
} from './OutcomeCard';
import { ModelSummary } from './ModelSummary';
import { RunPanel } from './RunPanel';
import { RunTaskConfirm, RunTaskMenu, STARTABLE_TASKS } from './RunTask';
import type { DispatchAnswer, RunPageRow } from './wire';
import {
  atWords, failureDetail, failureWords, dollars, KIND_ORDER, KIND_TASKS, KIND_WORDS, ledeClause, outcomeHeadline, ranOn, runLineWords, runNoun, shortTime, startedByChip, times, tokenWords,
  WINDOW_WORDS, type WorkWindow,
} from './words';

const WINDOW_FILTER: FilterDefinition = {
  key: 'window',
  label: 'When',
  options: [
    { value: 'week', label: 'This week' },
    { value: 'today', label: 'Today' },
  ],
};

const OUTCOME_FILTER: FilterDefinition = {
  key: 'outcome',
  label: 'Outcome',
  options: [{ value: 'all', label: 'All outcomes' }, ...KIND_ORDER.map((kind) => ({ value: kind, label: KIND_WORDS[kind] }))],
};

/** How many of an outcome's evidence lines, and of its runs, a card lists. */
const SHOWN = 3;
const RUNS_SHOWN = 5;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** A window's bounds on day boundaries, so they hold still while the day lasts: today, or the past seven days with today. */
export function workBounds(window: WorkWindow, now: number): { since: number; until: number } {
  const today = startOfDay(now);
  return { since: window === 'today' ? today : addDays(today, -6), until: addDays(today, 1) };
}

export interface WorkPageProps {
  /** The project the page is narrowed to, or null for every project. */
  projectId: string | null;
  projectName: (projectId: string) => string | null;
  /** The run whose panel is open, under the project. */
  runId: string | null;
}

/**
 * Myco's work: what Myco did in the background, told as outcomes rather than
 * run records. Each kind of work is a card with its evidence, its latest runs
 * and any failure beside it; search upkeep is one quiet line and the cost sits
 * in the rail. Every member reads all of it and can start a task by hand.
 */
export function WorkPage({ projectId, projectName, runId }: WorkPageProps) {
  const now = useNow();
  const [historyParams, setHistoryParams] = useSearchParams();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const location = useLocation();
  const filters = useFilterParams(['window', 'outcome'], { defaults: { window: 'week' } });
  const draft = useQueryDraft(filters.query, filters.setQuery);
  const window: WorkWindow = filters.values.window === 'today' ? 'today' : 'week';
  const picked = KIND_ORDER.find((kind) => kind === filters.values.outcome) ?? null;
  const bounds = workBounds(window, now);
  const work = useWorkWhileRunning({ projectId, ...bounds });
  const week = useWorkWhileRunning({ projectId, ...workBounds('week', now) }, { enabled: projectId !== null });
  const live = workHasLiveRun(work.data);
  const [asking, setAsking] = useState<string | null>(null);
  const [started, setStarted] = useState<{ task: string; answer: DispatchAnswer } | null>(null);
  const name = projectId === null ? null : projectName(projectId) ?? 'this project';
  const q = filters.query.trim().toLowerCase();
  const matches = (text: string) => q === '' || text.toLowerCase().includes(q);
  const kinds = work.data === undefined ? [] : summarize(work.data);
  const shown = picked === null ? kinds : kinds.filter((kind) => kind.kind === picked);
  const closeRun = () => {
    const from = (location.state as { from?: unknown } | null)?.from;
    navigate(typeof from === 'string' ? from : `${projectPath(projectId ?? '', WORK_SUFFIX)}${location.search}`);
  };

  return (
    <div className="flex w-full flex-col gap-s5" data-work="">
      <header className="flex flex-wrap items-start justify-between gap-x-s4 gap-y-s3">
        <div className="flex min-w-0 flex-col gap-s2">
          <h1 className="t-display text-ink">Myco’s work</h1>
          <p className="max-w-measure t-body text-muted">
            What Myco did in the background{name === null ? ', across every project' : ` in ${name}`}, grouped by what came of it.
          </p>
        </div>
        {projectId !== null && <RunTaskMenu projectId={projectId} week={week.data?.outcomes} now={now} onPick={(task) => { setStarted(null); setAsking(task); }} />}
      </header>
      {started !== null && projectId !== null && <StartedLine started={started} projectId={projectId} />}
      <FilterBar
        searchLabel="Search what Myco did"
        placeholder="Search what’s on this page"
        query={draft.text}
        onQueryChange={draft.setText}
        filters={[WINDOW_FILTER, OUTCOME_FILTER]}
        values={filters.values}
        onFilterChange={filters.setFilter}
        onClear={() => { draft.reset(); filters.clear(); }}
      />
      {projectId !== null && <Disclosure key={historyParams.get('runs') === 'all' ? 'all' : 'window'} summary="All-time run history" defaultOpen={historyParams.get('runs') === 'all'}>
        <div className="flex flex-col gap-s3">
          {KIND_ORDER.map((kind) => <TaskHistory key={kind} kind={kind} projectId={projectId} now={now} defaultOpen={historyParams.get('runs') === 'all' && picked === kind} />)}
        </div>
      </Disclosure>}
      {work.data !== undefined && kinds.length > 0 && <WorkLede kinds={kinds} window={window} name={name} projectCount={new Set(kinds.flatMap((kind) => kind.projects)).size} />}
      {work.data === undefined && work.isPending && <Skeleton className="h-s5 w-3/5" />}
      <div className="grid items-start gap-s6 lg:grid-rail">
        <section aria-label="What Myco did" className="flex min-w-0 flex-col gap-s4">
          {work.data === undefined ? (
            work.isPending ? <LoadingState label="Loading Myco’s work" count={4} /> : <ErrorState error={work.error} onRetry={() => void work.refetch()} />
          ) : shown.length === 0 ? (
            <EmptyState
              title={picked === null ? `Nothing ran ${WINDOW_WORDS[window].noun}` : `No ${KIND_WORDS[picked].toLowerCase()} ${WINDOW_WORDS[window].noun}`}
              action={<>
                {window === 'today' && <Button variant="ghost" size="sm" onClick={() => filters.setFilter('window', 'week')}>Show this week</Button>}
                {projectId !== null && <Button variant="secondary" size="sm" onClick={() => setHistoryParams((previous) => { const next = new URLSearchParams(previous); next.set('runs', 'all'); return next; })}>Show all · all time</Button>}
              </>}
            />
          ) : (
            shown.map((kind) => (
              <KindCard
                key={kind.kind}
                summary={kind}
                answer={work.data!}
                projectId={projectId}
                projectName={projectName}
                window={window}
                bounds={bounds}
                live={live}
                now={now}
                matches={matches}
                searching={q !== ''}
                onUpdateMap={projectId === null ? null : () => { setStarted(null); setAsking(KIND_TASKS.map); }}
              />
            ))
          )}
        </section>
        <aside aria-label="Upkeep and cost" className="flex min-w-0 flex-col gap-s4">
          {work.data !== undefined && <UpkeepCard answer={work.data} now={now} admin={admin} />}
          {work.data !== undefined && <CostCard kinds={kinds} window={window} />}
          <WhenCard projectId={projectId} name={name} admin={admin} />
        </aside>
      </div>
      {projectId !== null && (
        <RunTaskConfirm
          projectId={projectId}
          projectName={name ?? 'this project'}
          task={asking}
          onOpenChange={(open) => { if (!open) setAsking(null); }}
          week={week.data?.outcomes}
          admin={admin}
          now={now}
          onStarted={(task, answer) => setStarted({ task, answer })}
        />
      )}
      {projectId !== null && runId !== null && (
        <RunPanel projectId={projectId} runId={runId} projectName={name ?? 'this project'} now={now} onClose={closeRun} />
      )}
    </div>
  );
}

const STARTED_NOUN: Readonly<Record<string, string>> = {
  'extract-curate': 'Learning',
  'canopy-map': 'The code map update',
  'vault-seed': 'Learning from the code',
};

/** What happened to a task just started: queued, started, or not needed. */
function StartedLine({ started, projectId }: { started: { task: string; answer: DispatchAnswer }; projectId: string }) {
  const { answer } = started;
  const noun = STARTED_NOUN[started.task] ?? STARTABLE_TASKS.find((entry) => entry.task === started.task)?.label ?? 'The task';
  return (
    <p role="status" className="flex flex-wrap items-baseline gap-x-s3 gap-y-s1 rounded-control border border-line bg-ok-bg px-s3 py-s2 t-small text-ink-2" data-started="">
      {'outcome' in answer
        ? <span>Nothing has changed since the last run, so Myco didn’t start one and spent nothing.</span>
        : (
          <>
            <span>{answer.queued ? `${noun} is queued. It starts on the next free machine.` : `${noun} has started.`}</span>
            <OnwardLink to={runPath(projectId, answer.runId)}>Open the run</OnwardLink>
          </>
        )}
    </p>
  );
}

/** The sentence under the heading: what Myco's work came to, and any failure still open. */
function WorkLede({ kinds, window, name, projectCount }: { kinds: readonly KindSummary[]; window: WorkWindow; name: string | null; projectCount: number }) {
  const clauses = kinds.map((kind) => ledeClause(kind.kind, kind)).filter((clause): clause is string => clause !== null);
  const where = name === null ? (projectCount > 1 ? ` across ${count(projectCount, 'project')}` : '') : '';
  const lead = name === null ? WINDOW_WORDS[window].lead : `${WINDOW_WORDS[window].lead} in ${name}`;
  // Under one project the project is named in the lead, so Myco is "it".
  const subject = name === null ? 'Myco' : 'it';
  const failures = kinds.filter((kind) => kind.failures.length > 0).map((kind) => {
    const n = count(kind.failures.length, runNoun(kind.kind), runNoun(kind.kind, 2));
    return recovered(kind.failureGroups) ? `${capitalize(n)} failed; the ones since have worked.` : `${capitalize(n)} failed, and none has worked since.`;
  });
  return (
    <p className="max-w-measure t-body text-ink-2" data-lede="">
      {clauses.length === 0
        ? <>{lead}, Myco’s runs haven’t produced anything yet.</>
        : <>{lead}, {subject} {joinStrong(clauses)}{where}.</>}
      {failures.map((sentence) => <Fragment key={sentence}> {sentence}</Fragment>)}
    </p>
  );
}

function joinStrong(clauses: readonly string[]): ReactNode {
  return clauses.map((clause, i) => (
    <Fragment key={clause}>
      {i > 0 && (i === clauses.length - 1 ? ' and ' : ', ')}
      <strong className="font-semibold text-ink">{clause}</strong>
    </Fragment>
  ));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface KindCardProps {
  summary: KindSummary;
  answer: WorkAnswer;
  projectId: string | null;
  projectName: (projectId: string) => string | null;
  window: WorkWindow;
  bounds: { since: number; until: number };
  live: boolean;
  now: number;
  matches: (text: string) => boolean;
  searching: boolean;
  onUpdateMap: (() => void) | null;
}

/** One kind of work: its outcome, its evidence, its latest runs, and any failure. */
function KindCard({ summary, answer, projectId, projectName, window, bounds, live, now, matches, searching, onUpdateMap }: KindCardProps) {
  const location = useLocation();
  const [params] = useSearchParams();
  const name = useStarterNames();
  const { kind } = summary;
  // "Show all" opens the task's every run under a project; a link from the page across projects arrives with it open.
  const [all, setAll] = useState(projectId !== null && params.get('runs') === 'all' && params.get('outcome') === kind);
  const runs = useTaskRuns(projectId ?? '', KIND_TASKS[kind], live, projectId !== null, bounds);
  const every = useAllTaskRuns(projectId ?? '', KIND_TASKS[kind], projectId !== null && all);
  const scopedRows = all ? every.rows : runs.data?.rows ?? [];
  const from = { from: `${location.pathname}${location.search}` };
  const headline = outcomeHeadline(kind, summary);
  const machineOf = (id: string) => {
    const row = [...every.rows, ...(runs.data?.rows ?? [])].find((candidate) => candidate.id === id);
    return row === undefined ? null : ranOn(row.worker, name)?.machine ?? null;
  };
  const lineItems: RunLineItem[] = projectId === null
    ? summary.listed.slice(0, RUNS_SHOWN).map((run) => workRunLine(run, now, projectName))
    : (all ? scopedRows : scopedRows.slice(0, RUNS_SHOWN)).map((row) => pageRowLine(row, kind, projectId, now, name));
  const lines = lineItems.filter((item) => matches(item.words) || matches(item.where ?? ''));
  const groups = summary.failureGroups
    .map((group) => ({ ...group, failures: group.failures.filter((run) => matches(failureWords(run.failure)) || matches(failureDetail(run.failure) ?? '')) }))
    .filter((group) => group.failures.length > 0);
  const whole = matches(headline);
  const failed = summary.produced === 0 && summary.failed > 0 && summary.spores === 0;
  const loading = projectId !== null && (all ? every.isPending : runs.isPending);
  const more = projectId !== null && !all;
  return (
    <OutcomeCard
      kind={kind}
      headline={headline}
      failed={failed}
      meta={metaOf(summary, projectId === null, now)}
      action={kind === 'map' && onUpdateMap !== null ? <Button size="sm" onClick={onUpdateMap}>Update now</Button> : undefined}
    >
      <Evidence summary={summary} answer={answer} projectId={projectId} bounds={bounds} window={window} now={now} matches={whole ? () => true : matches} />
      {(lines.length > 0 || loading || projectId !== null) && (
        <div className="flex flex-col gap-s2">
          <PartLabel end={more ? <Button variant="ghost" size="sm" onClick={() => setAll(true)}>Show all · all time</Button> : undefined}>
            {all ? `Every ${runNoun(kind)} · all time` : window === 'today' ? 'Today’s runs' : 'This week’s runs'}
          </PartLabel>
          {loading ? <Skeleton className="h-s12 w-full rounded-control" /> : <RunLines items={lines} label={`Latest ${runNoun(kind, 2)}`} state={from} />}
          {all && every.hasMore && <ShowMore shown={every.rows.length} noun={runNoun(kind, 2)} onMore={every.more} pending={every.isFetchingMore} hasMore />}
          {projectId === null && (
            <p className="flex flex-wrap gap-x-s4 gap-y-s1" data-all-runs="">
              {summary.projects.map((id) => (
                <OnwardLink key={id} to={`${projectPath(id, WORK_SUFFIX)}?${new URLSearchParams({ outcome: kind, runs: 'all' })}`}>
                  All runs in {projectName(id) ?? 'a project'} · all time
                </OnwardLink>
              ))}
            </p>
          )}
        </div>
      )}
      {groups.map((group) => (
        <FailureBlock
          key={group.projectId}
          kind={kind}
          group={group}
          window={WINDOW_WORDS[window].noun}
          where={projectId === null ? projectName(group.projectId) ?? 'a project' : null}
          when={(at) => (at === null ? 'Earlier' : shortTime(at, now))}
          machineOf={machineOf}
          openTo={runPath}
        />
      ))}
      <KeptNote summary={summary} cause={summary.kept[0] === undefined ? null : failureWords(summary.kept[0].failure)} />
      {searching && !whole && lines.length === 0 && groups.length === 0 && <p className="t-small text-muted">Nothing here matches your search.</p>}
    </OutcomeCard>
  );
}

/** The card's line under its headline. */
function metaOf(summary: KindSummary, across: boolean, now: number): string {
  const where = across && summary.projects.length > 1 ? ` in ${count(summary.projects.length, 'project')}` : '';
  const latest = summary.latestAt === null ? '' : ` · the latest ${atWords(summary.latestAt, now)}`;
  const skipped = summary.runs.skipped ?? 0;
  const held = skipped > 0 ? ` · held off ${times(skipped)}` : '';
  if (summary.kind === 'map' && !across && summary.currentMaps.length === 1) {
    const map = summary.currentMaps[0]!;
    return `Now at ${map.branch} @ ${map.commit.slice(0, 7)}, ${atWords(map.generatedAt, now)}${held}`;
  }
  if (summary.kind === 'title' && summary.finished > 0) return `Each session as it ended${where}${latest}${held}`;
  return `${count(summary.finished, runNoun(summary.kind), runNoun(summary.kind, 2))}${where}${latest}${held}`;
}

/** A listed run across projects: when, what it came to, and its project. */
function workRunLine(run: WorkRun, now: number, projectName: (projectId: string) => string | null): RunLineItem {
  const at = run.at ?? now;
  return {
    key: run.id,
    time: shortTime(at, now),
    at,
    words: runLineWords(run.kind, { status: run.status, result: run.result, skipReason: null, targetSessionId: run.sessionId }, { ...run.outcome, readsRecorded: true }),
    model: <ModelSummary run={run} variant="list" />,
    where: projectName(run.projectId) ?? 'A project',
    by: null,
    tone: run.result === 'failed' ? 'bad' : 'plain',
    to: runPath(run.projectId, run.id),
  };
}

/** A run of the project's own list: when, what it came to, where it ran as the page may say it, and who started it. */
function pageRowLine(row: RunPageRow, kind: OutcomeKind, projectId: string, now: number, name: (id: string) => string | null): RunLineItem {
  const at = row.completedAt ?? row.startedAt ?? row.queuedAt ?? now;
  const live = row.status === 'queued' || row.status === 'running' || row.status === 'claimed';
  return {
    key: row.id,
    time: shortTime(at, now),
    at,
    words: runLineWords(kind, row, row.outcome),
    model: <ModelSummary run={row} variant="list" />,
    where: ranOn(row.worker, name)?.list ?? null,
    by: startedByChip(row.startedBy, name),
    tone: row.result === 'failed' ? 'bad' : row.status === 'skipped' ? 'held' : live ? 'live' : 'plain',
    to: runPath(projectId, row.id),
  };
}

interface EvidenceProps {
  summary: KindSummary;
  answer: WorkAnswer;
  projectId: string | null;
  bounds: { since: number; until: number };
  window: WorkWindow;
  now: number;
  matches: (text: string) => boolean;
}

/** What an outcome's runs left: the spores they wrote, the sessions they titled, or where the map stands. */
function Evidence(props: EvidenceProps) {
  const { summary } = props;
  if ((summary.kind === 'learn' || summary.kind === 'seed') && summary.spores > 0) return <SporeEvidence {...props} />;
  if (summary.kind === 'title' && summary.sessions > 0) return <TitleEvidence {...props} />;
  if (summary.kind === 'map' && summary.currentMaps.length > 0) return <MapEvidence {...props} />;
  return null;
}

function SporeEvidence({ summary, answer, projectId, bounds, window, matches }: EvidenceProps) {
  const spores = useWindowSpores(projectId, bounds.since, bounds.until);
  const runIds = new Set(answer.runs.filter((run) => run.kind === summary.kind).map((run) => run.id));
  const written: TodaySpore[] = (spores.data?.spores ?? []).filter((spore) => spore.author !== null && runIds.has(spore.author));
  const byType = new Map<string, number>();
  for (const spore of written) byType.set(spore.observationType, (byType.get(spore.observationType) ?? 0) + 1);
  const complete = written.length === summary.spores;
  const lines: EvidenceLine[] = written.filter((spore) => matches(sporeLine(spore))).slice(0, SHOWN).map((spore) => ({
    key: `${spore.projectId}/${spore.id}`,
    chip: sporeTypeWord(spore.observationType),
    text: sporeLine(spore),
    to: projectPath(spore.projectId, `/spores/${encodeURIComponent(spore.id)}`),
  }));
  const knowledge = `${projectId === null ? KNOWLEDGE_SUFFIX : projectPath(projectId, KNOWLEDGE_SUFFIX)}${window === 'week' ? '?window=week' : ''}`;
  if (spores.isPending) return <Skeleton className="h-s12 w-full rounded-control" />;
  return (
    <div className="flex flex-col gap-s3">
      {complete && byType.size > 0 && (
        <p className="flex flex-wrap gap-x-s3 gap-y-s1 t-small text-muted" data-spore-types="">
          {[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => (
            <span key={type}><span className="font-medium text-ink-2">{n.toLocaleString()}</span> {n === 1 ? sporeTypeWord(type).toLowerCase() : pluralType(type)}</span>
          ))}
        </p>
      )}
      <EvidenceLines label="Spores it wrote" lines={lines} more={0} />
      <p className="flex flex-wrap gap-x-s4 gap-y-s1">
        <OnwardLink to={knowledge}>See {summary.spores === 1 ? 'it' : `all ${summary.spores.toLocaleString()}`} in Knowledge</OnwardLink>
        {summary.kind === 'learn' && <OnwardLink to={sessionsOf(projectId, window)}>{WINDOW_WORDS[window].lead}’s sessions</OnwardLink>}
      </p>
    </div>
  );
}

function pluralType(type: string): string {
  const word = sporeTypeWord(type).toLowerCase();
  if (word.endsWith('x')) return `${word}es`;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function TitleEvidence({ summary, projectId, window, now, matches }: EvidenceProps) {
  const titled = summary.listed.filter((run) => run.result === 'produced' && run.sessionId !== null).slice(0, SHOWN);
  const reads = useSessionsById(titled.map((run) => ({ projectId: run.projectId, sessionId: run.sessionId! })));
  const lines: EvidenceLine[] = titled.flatMap((run, i) => {
    const session = reads[i]?.data?.session;
    if (session === undefined) return [];
    const text = sessionHeadingText(session);
    return matches(text) ? [{
      key: run.id,
      text,
      detail: `${agentName(session.agent)} · ${run.at === null ? 'titled' : `titled ${atWords(run.at, now)}`}`,
      to: projectPath(run.projectId, `/sessions/${encodeURIComponent(session.sessionId)}`),
    }] : [];
  });
  if (reads.some((read) => read.isPending) && lines.length === 0) return <Skeleton className="h-s12 w-full rounded-control" />;
  return (
    <div className="flex flex-col gap-s3">
      <EvidenceLines label="Sessions it titled" lines={lines} more={Math.max(0, summary.sessions - lines.length)} />
      <OnwardLink to={sessionsOf(projectId, window)}>See {WINDOW_WORDS[window].noun === 'today' ? 'today’s' : 'this week’s'} sessions</OnwardLink>
    </div>
  );
}

/**
 * The Sessions list over the page's window. No read lists the sessions a set
 * of runs read or titled, so the link names the window, not a count.
 */
function sessionsOf(projectId: string | null, window: WorkWindow): string {
  return `${projectId === null ? '/sessions' : projectPath(projectId, '/sessions')}?window=${window}`;
}

function MapEvidence({ summary, projectId, now }: EvidenceProps) {
  if (projectId !== null) return <OnwardLink to={projectPath(projectId, CODE_MAP_SUFFIX)}>Open the code map</OnwardLink>;
  return (
    <EvidenceLines
      label="Code maps"
      more={Math.max(0, summary.currentMaps.length - SHOWN)}
      lines={summary.currentMaps.slice(0, SHOWN).map((map) => ({
        key: map.projectId,
        text: `${map.branch} @ ${map.commit.slice(0, 7)}`,
        detail: atWords(map.generatedAt, now),
        to: projectPath(map.projectId, CODE_MAP_SUFFIX),
      }))}
    />
  );
}

/** The search index's upkeep as one quiet line, with Health one click away for an admin. */
function UpkeepCard({ answer, now, admin }: { answer: WorkAnswer; now: number; admin: boolean }) {
  const line = <UpkeepLine upkeep={answer.upkeep} now={now} statusHref={admin ? `${HEALTH_PATH}#${HEALTH_ANCHORS.upkeep}` : null} />;
  return (
    <Card className="flex flex-col gap-s2" data-upkeep-card="">
      <h2 className="t-h3 text-ink">Upkeep in the background</h2>
      {answer.upkeep.lastSuccessAt === null && answer.upkeep.unrecovered === null
        ? <p className="t-small text-muted">Search hasn’t needed updating yet.</p>
        : line}
    </Card>
  );
}

/** What the window cost, as the agents themselves reported it, and how many runs reported nothing. */
function CostCard({ kinds, window }: { kinds: readonly KindSummary[]; window: WorkWindow }) {
  const cost = costOf(kinds);
  return (
    <Card className="flex flex-col gap-s2" data-cost="">
      <h2 className="t-h3 text-ink">What it cost {WINDOW_WORDS[window].noun}</h2>
      <p className="t-display tabular-nums text-ink" data-cost-total="">{dollars(cost.costUsd)}</p>
      <p className="t-small text-muted">{cost.tokens > 0 ? `${tokenWords(cost.tokens)} tokens over ${count(cost.runs, 'run')}.` : `${count(cost.runs, 'run')}.`}</p>
      <p className="t-small text-muted">
        Recorded costs may include agent estimates and estimates using model prices; they are not a bill.
        {cost.runsWithoutCost > 0 && ` ${cost.runsWithoutCost === 1 ? 'One run' : `${cost.runsWithoutCost.toLocaleString()} runs`} reported no cost, so the total is incomplete.`}
      </p>
    </Card>
  );
}

/** When Myco does its work on its own, and where that is changed. */
function WhenCard({ projectId, name, admin }: { projectId: string | null; name: string | null; admin: boolean }) {
  return (
    <Card className="flex flex-col gap-s2" data-when="">
      <h2 className="t-h3 text-ink">When Myco runs</h2>
      <ul className="flex list-disc flex-col gap-s1 pl-s5 t-small text-muted">
        <li>Learning runs through the day, while there are prompts it hasn’t read, up to a daily limit.</li>
        <li>A session is titled when it ends.</li>
        <li>The code map updates when the repository moves.</li>
        <li>Work runs on your machines, on an agent that is signed in there.</li>
      </ul>
      {projectId === null
        ? <p className="t-small text-muted">To start a task by hand, pick a project in the nav.</p>
        : admin && <OnwardLink to={`${projectPath(projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.capabilities}`}>Change what Myco does in {name}</OnwardLink>}
    </Card>
  );
}

function TaskHistory({ kind, projectId, now, defaultOpen }: { kind: OutcomeKind; projectId: string; now: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const every = useAllTaskRuns(projectId, KIND_TASKS[kind], open);
  const name = useStarterNames();
  return (
    <Disclosure summary={`${capitalize(runNoun(kind, 2))} · all time`} defaultOpen={defaultOpen} onOpenChange={setOpen}>
      {every.isPending ? <LoadingState label="Loading runs" count={3} /> : every.error !== null ? <ErrorState error={every.error} onRetry={every.retry} /> : every.rows.length === 0 ? <p className="t-small text-muted">No runs recorded.</p> : (
        <>
          <RunLines label={`All-time ${runNoun(kind, 2)}`} items={every.rows.map((row) => pageRowLine(row, kind, projectId, now, name))} />
          {every.hasMore && <ShowMore shown={every.rows.length} noun="runs" hasMore onMore={every.more} pending={every.isFetchingMore} />}
        </>
      )}
    </Disclosure>
  );
}
