import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Disclosure, EmptyState, ErrorState, LoadingState } from '../../design';
import { useTaskDescriptions } from '../../hooks/use-tasks';
import { useTaskRuns } from '../../hooks/use-work';
import { useNow } from '../../hooks/use-today';
import { harnessLabel } from '../../lib/harness';
import { projectPath, runPath, TASKS_SUFFIX, WORK_SUFFIX } from '../../routes/nav';
import { ModelSummary, displayModel } from '../work/ModelSummary';
import { OnwardLink } from '../work/OutcomeCard';
import { kindOf, runLineWords, shortTime } from '../work/words';
import type { TaskDescription } from './wire';

const LONG_TOOLS_THRESHOLD = 4;

/** The server's descriptions of every task, with its exact instructions folded away. */
export function TasksPage({ projectId }: { projectId: string | null }) {
  const tasks = useTaskDescriptions(projectId);
  const location = useLocation();
  useEffect(() => {
    if (location.hash !== '') document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView?.({ block: 'start' });
  }, [location.hash, tasks.data]);
  return (
    <div className="flex w-full min-w-0 flex-col gap-s5" data-tasks="">
      <header className="flex flex-wrap items-start justify-between gap-s3">
        <div className="flex min-w-0 flex-col gap-s2">
          <h1 className="t-display text-ink">Tasks</h1>
          <p className="max-w-measure t-body text-muted">What Myco does, when it runs, and what each task must leave behind.</p>
        </div>
        <OnwardLink to={projectId === null ? WORK_SUFFIX : projectPath(projectId, WORK_SUFFIX)}>Myco’s work</OnwardLink>
      </header>
      {tasks.scopeError !== null ? <ErrorState error={tasks.scopeError} onRetry={() => void tasks.retryScope()} />
        : tasks.scopeEmpty ? <EmptyState title="Pick a project to see its tasks" />
        : tasks.data === undefined
        ? tasks.isPending ? <LoadingState label="Loading tasks" count={4} /> : <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
        : <section aria-label="Myco’s tasks" className="grid min-w-0 items-start gap-s4 xl:grid-cols-2">
          {tasks.data.tasks.map((task) => <TaskCard key={task.task} task={task} projectId={projectId} />)}
        </section>}
    </div>
  );
}

function TaskCard({ task, projectId }: { task: TaskDescription; projectId: string | null }) {
  const [params] = useSearchParams();
  const recent = params.get('task') === task.task && params.get('runs') === 'recent';
  const path = projectId === null ? TASKS_SUFFIX : projectPath(projectId, TASKS_SUFFIX);
  return (
    <article id={task.task} data-task={task.task} className="flex min-w-0 scroll-mt-s5 flex-col gap-s4 rounded-card border border-line bg-surface-1 p-s4">
      <header className="flex flex-col gap-s2">
        <h2 className="t-h2 text-ink">{task.name}</h2>
        <p className="max-w-measure t-body text-ink-2">{task.description}</p>
      </header>
      <Facts label="When it runs" lines={task.triggers} />
      {task.tools.length > LONG_TOOLS_THRESHOLD ? <>
        <div className="sm:hidden"><Disclosure summary="What it may use"><Facts label="What it may use" lines={task.tools} /></Disclosure></div>
        <div className="hidden sm:block"><Facts label="What it may use" lines={task.tools} /></div>
      </> : task.tools.length > 0 && <Facts label="What it may use" lines={task.tools} />}
      <Facts label="What done means" lines={task.done} />
      {task.availabilityNote !== null && <p className="t-small text-warn" data-task-availability="">{task.availabilityNote}</p>}
      {(task.tier !== null || task.profiles.length > 0 || task.profileNote !== null || task.budget !== null) && <section aria-label={task.budget === null ? 'How it runs' : 'Model and budget'} className="flex flex-col gap-s2">
        <h3 className="t-label text-muted">{task.budget === null ? 'How it runs' : 'Model and budget'}</h3>
        {(task.tier !== null || task.profiles.length > 0) && <div className="flex flex-col gap-s1 break-words t-small text-ink-2" data-task-model="">
          {task.profiles.length === 0 && task.tier !== null && <p>{task.tier} tier</p>}
          {task.profiles.map((profile) => <p key={profile.harness} data-task-profile="">
            {task.tier === null ? '' : `${task.tier} tier · `}{harnessLabel(profile.harness)}{profile.model === null ? '' : `: ${displayModel(profile.model)}${profile.effort === null ? '' : `, ${profile.effort} effort`}`}
          </p>)}
        </div>}
        {task.profiles.filter((profile) => profile.note !== null).map((profile) => <p key={profile.harness} className="t-small text-muted">{profile.note}</p>)}
        {task.profileNote !== null && <p className="t-small text-muted">{task.profileNote}</p>}
        {task.budget !== null && <><p className="t-small text-ink-2">Up to {task.budget.timeoutSeconds.toLocaleString()} seconds per run.</p>
        <Disclosure summary="Reading limits">
          <dl className="grid grid-cols-2 gap-x-s3 gap-y-s2 t-small text-ink-2">
            <dt>Spores per page</dt><dd>{task.budget.readWindow.sporePage}</dd>
            <dt>Spore preview characters</dt><dd>{task.budget.readWindow.sporePreviewChars}</dd>
            <dt>Spore body characters</dt><dd>{task.budget.readWindow.sporeBodyChars}</dd>
            <dt>Full spore reads</dt><dd>{task.budget.readWindow.sporeFullReads}</dd>
            <dt>Sessions per page</dt><dd>{task.budget.readWindow.sessionPage}</dd>
            <dt>Session title characters</dt><dd>{task.budget.readWindow.sessionTitleChars}</dd>
            <dt>Session summary characters</dt><dd>{task.budget.readWindow.sessionSummaryChars}</dd>
            <dt>Session label characters</dt><dd>{task.budget.readWindow.sessionLabelChars}</dd>
            <dt>New prompts per page</dt><dd>{task.budget.readWindow.promptPage}</dd>
          </dl>
        </Disclosure></>}
      </section>}
      {(task.promptTemplate !== null || task.standingRules !== null || task.templateVariants.length > 0) && <Disclosure summary="Exact rules and prompt template">
        <div className="flex min-w-0 flex-col gap-s4" data-task-instruction="">
          {task.promptTemplate !== null && <ExactText label="Prompt template" text={task.promptTemplate} />}
          {task.standingRules !== null && <ExactText label="Standing rules" text={task.standingRules} />}
          {task.templateVariants.map((variant) => <ExactText key={variant.name} label={variant.name} text={variant.prompt} />)}
        </div>
      </Disclosure>}
      {projectId === null ? <p className="t-small text-muted">Pick a project in the nav to see this task’s recent runs.</p> : <>
        <OnwardLink to={`${path}?${new URLSearchParams({ task: task.task, runs: 'recent' })}#${encodeURIComponent(task.task)}`}>Recent runs</OnwardLink>
        {recent && <RecentRuns task={task} projectId={projectId} />}
      </>}
    </article>
  );
}

function Facts({ label, lines }: { label: string; lines: readonly string[] }) {
  return <section aria-label={label} className="flex flex-col gap-s2">
    <h3 className="t-label text-muted">{label}</h3>
    {lines.length === 0 ? <p className="t-small text-muted">None.</p> : <ul className="flex flex-col gap-s1 t-small text-ink-2">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
  </section>;
}

function ExactText({ label, text }: { label: string; text: string }) {
  return <section aria-label={label} className="flex min-w-0 flex-col gap-s2">
    <h3 className="t-label text-muted">{label}</h3>
    <pre className="whitespace-pre-wrap break-words rounded-control border border-line bg-surface-2 p-s3 t-small text-ink-2" data-task-exact="">{text}</pre>
  </section>;
}

function RecentRuns({ task, projectId }: { task: TaskDescription; projectId: string }) {
  const runs = useTaskRuns(projectId, task.task, false);
  const now = useNow();
  return <section aria-label={`Recent runs of ${task.name}`} className="flex flex-col gap-s2">
    <h3 className="t-label text-muted">Recent runs</h3>
    {runs.data === undefined ? runs.isPending ? <LoadingState label="Loading recent runs" count={2} /> : <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      : runs.data.rows.length === 0 ? <p className="t-small text-muted">This task has no recorded runs in this project.</p>
        : <ul className="flex flex-col gap-s2">{runs.data.rows.map((run) => <li key={run.id} className="flex flex-col gap-s1">
          <OnwardLink to={runPath(projectId, run.id)}>{runLineWords(kindOf(run.task), run, run.outcome)}</OnwardLink>
          <span className="t-meta text-muted">{shortTime(run.completedAt ?? run.startedAt ?? run.queuedAt ?? now, now)}</span>
          <ModelSummary run={run} variant="list" />
        </li>)}</ul>}
  </section>;
}
