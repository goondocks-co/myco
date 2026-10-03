import { Fragment, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { holdSentence } from '@goondocks/myco-shared/run-holds';
import { ActionLink, ActionMenu, Button, Dialog, DialogContent, DialogFooter, ErrorState, LoadingState, Skeleton, Switch } from '../../design';
import { useTaskDescriptions, useTaskStartPreview } from '../../hooks/use-tasks';
import { useCapabilities } from '../../hooks/use-settings';
import { useProjects } from '../../hooks/use-projects';
import { runIsLive, useDispatchTask, useRunDetail, useWorkWhileRunning } from '../../hooks/use-work';
import { ApiError } from '../../lib/api';
import { harnessLabel } from '../../lib/harness';
import { PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath, runPath } from '../../routes/nav';
import { ProjectPick } from '../../routes/scope';
import type { WorkOutcome } from '../today/wire';
import type { TaskStartPreview } from '../tasks/wire';
import { displayModel } from './ModelSummary';
import { useStarterNames } from './names';
import { OnwardLink } from './OutcomeCard';
import type { DispatchAnswer } from './wire';
import { workBounds } from './window';
import {
  agentWords, allowanceWords, atWords, capabilityOffWords, dailyLimitWords, executionWords, isCapabilityOff, isDailyLimit, isFreshNeedsAdmin, ranOn, readinessWords, spendWords, waitWords,
} from './words';

/** What the page calls a task started by hand: its menu line, its confirming button, its runs and its started line. Which tasks may be started is the server's answer (`TaskDescription.startable`). */
export interface StartableTask {
  task: string;
  label: string;
  /** Its confirming button. */
  confirm: string;
  /** Its runs, plural, as the spend line names them: "learning runs". */
  noun: string;
  /** What the line after it starts calls it: "Learning". */
  started: string;
}

export const STARTABLE_TASKS: readonly StartableTask[] = [
  {
    task: 'extract-curate',
    label: 'Learn from new sessions now',
    confirm: 'Learn now',
    noun: 'learning runs',
    started: 'Learning',
  },
  {
    task: 'canopy-map',
    label: 'Update the code map now',
    confirm: 'Update the code map',
    noun: 'updates',
    started: 'The code map update',
  },
  {
    task: 'vault-seed',
    label: 'Learn from the project’s code',
    confirm: 'Learn from the code',
    noun: 'runs over the code',
    started: 'Learning from the code',
  },
];

/** Where a task sits in the menu: in the order the page has words for, any other after them. */
const wordsOrder = (task: string): number => {
  const at = STARTABLE_TASKS.findIndex((entry) => entry.task === task);
  return at === -1 ? STARTABLE_TASKS.length : at;
};

/** The words for a task started by hand: its own, or for a task the server starts by hand that the page has no words for, ones built from its name. */
export function startableEntry(task: string, name: string | null): StartableTask {
  return STARTABLE_TASKS.find((entry) => entry.task === task) ?? {
    task, label: `Run ${name ?? 'this task'} now`, confirm: 'Run it now', noun: 'runs', started: name ?? 'The task',
  };
}

export interface RunTaskMenuProps {
  /** The project the page shows, or null across every project, where the confirmation asks which. */
  projectId: string | null;
  /** The week's work in this project, for each task's last update line. */
  week: readonly WorkOutcome[] | undefined;
  now: number;
  onPick: (task: string) => void;
}

/** "Run a task": every task the server says a person may start by hand, each saying what it does, when it last ran, or why it waits. */
export function RunTaskMenu({ projectId, week, now, onPick }: RunTaskMenuProps) {
  const capabilities = useCapabilities(projectId ?? '', { enabled: projectId !== null });
  const descriptions = useTaskDescriptions(projectId);
  const on = projectId === null ? undefined : capabilities.data?.capabilities;
  return (
    <ActionMenu
      label="Run a task"
      icon={<Play aria-hidden className="size-s4" />}
      items={(descriptions.data?.tasks ?? []).filter((task) => task.startable).sort((a, b) => wordsOrder(a.task) - wordsOrder(b.task)).map((task) => {
        const entry = startableEntry(task.task, task.name);
        const off = task.capability !== null && on !== undefined && on[task.capability] === false;
        const latest = week?.find((outcome) => outcome.task === task.task)?.latestAt ?? null;
        return {
          label: entry.label,
          detail: off ? capabilityOffWords(task.capability!) : latest === null ? task.description : `Last ran ${atWords(latest, now)}`,
          onSelect: () => onPick(task.task),
        };
      })}
    />
  );
}

/** A task just started by hand, in the project it was started in. */
export interface StartedRun {
  task: string;
  projectId: string;
  answer: DispatchAnswer;
}

export interface RunTaskConfirmProps {
  /** The project the page shows, or null across every project, when the confirmation first asks which. */
  projectId: string | null;
  /** The task being confirmed, or null while none is. */
  task: string | null;
  onOpenChange: (open: boolean) => void;
  admin: boolean;
  now: number;
  onStarted: (started: StartedRun) => void;
}

/**
 * The confirmation every task started by hand passes through, wherever it is
 * started from: which project, when the page shows every one; what it will do
 * there; the agent and model it would run on, or what it would wait for; whether
 * there is anything for it to do; and what this week's runs of it spent. An
 * admin may start it fresh; a member never sees that choice, and reads how many
 * more they may start today.
 */
export function RunTaskConfirm(props: RunTaskConfirmProps) {
  if (props.task === null) return null;
  return <Confirm key={`${props.task}/${props.projectId ?? ''}`} {...props} task={props.task} />;
}

function Confirm({ projectId, task, onOpenChange, admin, now, onStarted }: RunTaskConfirmProps & { task: string }) {
  const [chosen, setChosen] = useState<string | null>(projectId);
  const projects = useProjects();
  const projectName = chosen === null ? null : projects.data?.projects.find((project) => project.projectId === chosen)?.name ?? 'this project';
  const descriptions = useTaskDescriptions(chosen ?? projectId);
  const description = descriptions.data?.tasks.find((row) => row.task === task);
  const entry = startableEntry(task, description?.name ?? null);
  const dispatch = useDispatchTask(chosen ?? '');
  const capabilities = useCapabilities(chosen ?? '', { enabled: chosen !== null });
  const preview = useTaskStartPreview(chosen, task);
  const week = useWorkWhileRunning({ projectId: chosen, ...workBounds('week', now) }, { enabled: chosen !== null });
  const [fresh, setFresh] = useState(false);
  // One ask at a time: set before the dispatch goes out, so a second click in the same tick sends nothing.
  const asking = useRef(false);
  const close = (open: boolean) => {
    if (dispatch.isPending) return;
    if (!open) { dispatch.reset(); setFresh(false); }
    onOpenChange(open);
  };
  const capability = description?.capability ?? preview.data?.capability?.name ?? null;
  const switchedOff = chosen !== null && capability !== null
    && (capabilities.data?.capabilities[capability] === false || preview.data?.capability?.on === false);
  // Nothing is started on a confirmation still reading what it would say.
  const reading = chosen !== null && (preview.isPending || week.isPending);
  const outcome = week.data?.outcomes.find((candidate) => candidate.task === task);
  const spend = spendWords(outcome?.spend, entry.noun, 'This week');
  const refusal = dispatch.error === null ? null : refusalOf(dispatch.error, now);
  const offCapability = refusal?.capability ?? (switchedOff ? capability! : null);
  const allowance = preview.data?.allowance ?? null;
  const spent = allowance !== null && allowanceWords(allowance) === null;
  const where = projectName === null ? null : `in the ${projectName} project`;
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        title={`${entry.label}?`}
        description={description === undefined
          ? (where === null ? undefined : `${where.charAt(0).toUpperCase()}${where.slice(1)}.`)
          : where === null ? description.description : `${description.description.replace(/\.$/, '')} ${where}.`}
        hideClose
        data-run-task-confirm={task}
      >
        {projectId === null && (
          <div className="flex flex-col gap-s2" data-run-task-project="">
            <span className="t-small font-medium text-ink">Which project?</span>
            <ProjectPick value={chosen} onChange={(id) => { dispatch.reset(); setChosen(id); }} />
          </div>
        )}
        {descriptions.isError && <ErrorState error={descriptions.error} onRetry={() => void descriptions.refetch()} />}
        {descriptions.isPending && <LoadingState label="Loading task description" count={1} />}
        {descriptions.data !== undefined && description === undefined && <p role="alert" className="t-small text-bad">This task’s description is unavailable.</p>}
        {chosen === null ? (
          <p className="t-small text-muted">Choose the project to run it in.</p>
        ) : offCapability !== null ? (
          <p role="alert" className="flex flex-col gap-s1 t-small text-ink-2" data-capability-off="">
            <span className="font-medium text-bad">{capabilityOffWords(offCapability)}</span>
            {admin
              ? <ActionLink to={`${projectPath(chosen, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.capabilities}`} >Turn it on in Project settings →</ActionLink>
              : <span>An admin can turn it on in the project’s settings.</span>}
          </p>
        ) : (
          <>
            <StartPreview preview={preview.data} pending={preview.isPending} failed={preview.isError} took={week.data === undefined ? null : spend.took} />
            {allowance !== null && (spent
              ? <p role="alert" className="t-small text-bad" data-allowance="spent">{dailyLimitWords(allowance, now)}</p>
              : <p className="t-small text-ink-2" data-allowance="">{allowanceWords(allowance)}</p>)}
            {week.isPending ? <Skeleton className="h-s8 w-full rounded-control" /> : (
              <p className="rounded-control border border-line bg-warn-bg px-s3 py-s2 t-small text-ink-2" data-spend="">
                <span className="font-medium text-ink">This spends model tokens.</span>{' '}
                {week.data === undefined
                  ? 'This week’s spend couldn’t be read.'
                  : spend.spend ?? `No ${entry.noun} finished this week, so there’s no recent spend to go by.`}
              </p>
            )}
            {admin && (
              <div className="flex items-start justify-between gap-s4 t-small text-ink-2">
                <span className="flex flex-col gap-s1">
                  <span className="font-medium text-ink">Start fresh</span>
                  <span className="text-muted">Run it even if nothing has changed since the last run.</span>
                </span>
                <Switch checked={fresh} onCheckedChange={setFresh} aria-label="Start fresh" />
              </div>
            )}
            {refusal !== null && <p role="alert" className="t-small text-bad" data-refusal="">{refusal.words}</p>}
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={dispatch.isPending}>{offCapability === null ? 'Cancel' : 'Close'}</Button>
          {offCapability === null && (
            <Button
              variant="primary"
              pending={dispatch.isPending}
              disabled={chosen === null || reading || spent || refusal?.final === true || description === undefined}
              onClick={() => {
                if (asking.current || chosen === null) return;
                asking.current = true;
                dispatch.mutate({ task, fresh: admin && fresh }, {
                  onSuccess: (answer) => { onStarted({ task, projectId: chosen, answer }); close(false); },
                  onSettled: () => { asking.current = false; },
                });
              }}
            >
              {entry.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A machine as the confirmation names it in a sentence: its name to its owner, and to anyone else as its member's. */
function machineWords(worker: TaskStartPreview['executions'][number]['workers'][number], name: (id: string) => string | null): string {
  const machine = ranOn(worker, name)?.machine ?? 'a machine';
  return machine === 'Your machine' ? 'your machine' : machine;
}

/**
 * Where a run started now would go and whether it has anything to do, as the
 * server resolves them now. When the machines that checked in lately would run
 * it differently, each way is named with its machines: whichever asks first
 * takes it, so none is promised.
 */
function StartPreview({ preview, pending, failed, took }: { preview: TaskStartPreview | undefined; pending: boolean; failed: boolean; took: string | null }) {
  const name = useStarterNames();
  if (preview === undefined) {
    if (pending) return <Skeleton className="h-s8 w-full rounded-control" />;
    return <p className="t-small text-muted" data-run-on="">{failed ? 'Couldn’t read which agent would run it.' : ''}</p>;
  }
  const readiness = preview.readiness === null ? null : readinessWords(preview.readiness);
  const { executions } = preview;
  const model = (execution: TaskStartPreview['executions'][number], tier: boolean) => (
    <span className="font-medium text-ink" data-run-model="">{(tier ? executionWords : agentWords)(execution, harnessLabel, displayModel)}</span>
  );
  return (
    <div className="flex flex-col gap-s2 t-small text-ink-2">
      {executions.length === 1 ? (
        <p data-run-on="">It will run on {model(executions[0]!, true)}.{took === null ? '' : ` ${took}`}</p>
      ) : executions.length > 1 ? (
        <p data-run-on="" data-run-choice="">
          At its {executions[0]!.tier} tier, it will run on whichever machine is free first:{' '}
          {executions.map((execution, index) => (
            <Fragment key={`${execution.harness}/${execution.model}/${execution.effort ?? ''}/${execution.tier}`}>
              {index > 0 && (index === executions.length - 1 ? ', or ' : ', ')}
              {model(execution, false)} on {execution.workers.map((worker) => machineWords(worker, name)).join(' or ')}
            </Fragment>
          ))}.{took === null ? '' : ` ${took}`}
        </p>
      ) : (
        <p className="rounded-control border border-line bg-warn-bg px-s3 py-s2" data-run-on="" data-run-held={preview.heldBy ?? ''}>
          {waitWords(preview.heldBy ?? 'worker', preview.workers)}{took === null ? '' : ` ${took}`}
        </p>
      )}
      {readiness !== null && <p data-readiness={preview.readiness!.met ? 'met' : 'unmet'}>{readiness}</p>}
      {preview.live && <p data-already-live="">One is already waiting or running in this project. Starting another queues a second run.</p>}
    </div>
  );
}

/**
 * The line after a task is started: that nothing had changed, or how the run
 * stands now and a link to its panel. A run still in the queue says it waits
 * for a worker and what holds it, as the run itself names it.
 */
export function StartedLine({ started }: { started: StartedRun }) {
  const { answer } = started;
  const frame = 'flex flex-wrap items-baseline gap-x-s3 gap-y-s1 rounded-control border border-line bg-ok-bg px-s3 py-s2 t-small text-ink-2';
  if ('outcome' in answer) {
    return (
      <p role="status" className={frame} data-started="unchanged">
        <span>Nothing has changed since the last run, so Myco didn’t start one and spent nothing.</span>
      </p>
    );
  }
  return <StartedRunLine started={started} runId={answer.runId} queued={answer.queued} className={frame} />;
}

function StartedRunLine({ started, runId, queued, className }: { started: StartedRun; runId: string; queued: boolean; className: string }) {
  const detail = useRunDetail(started.projectId, runId, { retry: false });
  const run = detail.data?.run;
  const status = run?.status ?? (queued ? 'queued' : 'running');
  const noun = startableEntry(started.task, null).started;
  const state = status === 'queued' ? 'queued' : runIsLive(status) ? 'running' : 'finished';
  const held = holdSentence(run?.heldBy ?? 'worker') ?? holdSentence('worker')!;
  const words = state === 'queued' ? `${noun} is queued. ${held}` : state === 'running' ? `${noun} has started.` : `${noun} has finished.`;
  return (
    <p role="status" className={className} data-started={state}>
      <span>{words}</span>
      <OnwardLink to={runPath(started.projectId, runId)}>Open the run</OnwardLink>
    </p>
  );
}

/** A dispatch's refusal in the reader's words, the capability it names when it names one, and whether trying again now can help. */
function refusalOf(error: Error, now: number): { words: string; capability: string | null; final: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 429 && isDailyLimit(error.body)) return { words: dailyLimitWords(error.body, now), capability: null, final: true };
    if (error.status === 409 && isCapabilityOff(error.body)) return { words: capabilityOffWords(error.body.capability), capability: error.body.capability, final: true };
    if (error.status === 403 && isFreshNeedsAdmin(error.body)) return { words: 'Only an admin can start a task fresh.', capability: null, final: false };
    return { words: `The server couldn’t start it (${error.status}). Try again in a moment.`, capability: null, final: false };
  }
  return { words: 'Couldn’t reach the server. Try again in a moment.', capability: null, final: false };
}
