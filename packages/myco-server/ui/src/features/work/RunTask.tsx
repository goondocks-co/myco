import { useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { ActionMenu, Button, Dialog, DialogContent, DialogFooter, Link, Switch } from '../../design';
import { useCapabilities } from '../../hooks/use-settings';
import { useDispatchTask } from '../../hooks/use-work';
import { ApiError } from '../../lib/api';
import { PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath } from '../../routes/nav';
import type { WorkOutcome } from '../today/wire';
import type { DispatchAnswer } from './wire';
import { atWords, capabilityOffWords, dailyLimitWords, isCapabilityOff, isDailyLimit, isFreshNeedsAdmin, spendWords, TASK_CAPABILITY } from './words';

/** A task a member can start by hand, and what its confirmation says. */
export interface StartableTask {
  task: string;
  label: string;
  /** What it will do, in the project's name. */
  does: (project: string) => string;
  /** Its confirming button. */
  confirm: string;
  /** Its runs, plural, as the spend line names them: "learning runs". */
  noun: string;
}

export const STARTABLE_TASKS: readonly StartableTask[] = [
  {
    task: 'extract-curate',
    label: 'Learn from new sessions now',
    does: (project) => `Myco will read the prompts in ${project} it hasn’t read yet and save what’s worth keeping as spores.`,
    confirm: 'Learn now',
    noun: 'learning runs',
  },
  {
    task: 'canopy-map',
    label: 'Update the code map now',
    does: (project) => `Myco will read ${project}’s repository and update the code map to its latest commit.`,
    confirm: 'Update the code map',
    noun: 'updates',
  },
  {
    task: 'vault-seed',
    label: 'Learn from the project’s code',
    does: (project) => `Myco will read ${project}’s repository and save what it learns about the code as spores.`,
    confirm: 'Learn from the code',
    noun: 'runs over the code',
  },
];

export interface RunTaskMenuProps {
  projectId: string;
  /** The week's work in this project, for each task's last update line. */
  week: readonly WorkOutcome[] | undefined;
  now: number;
  onPick: (task: string) => void;
}

/** "Run a task": what can be started now in this project, each saying what it does or why it waits. */
export function RunTaskMenu({ projectId, week, now, onPick }: RunTaskMenuProps) {
  const capabilities = useCapabilities(projectId);
  const on = capabilities.data?.capabilities;
  return (
    <ActionMenu
      label="Run a task"
      icon={<Play aria-hidden className="size-s4" />}
      items={STARTABLE_TASKS.map((entry) => {
        const capability = TASK_CAPABILITY[entry.task];
        const off = capability !== undefined && on !== undefined && on[capability] === false;
        const latest = week?.find((outcome) => outcome.task === entry.task)?.latestAt ?? null;
        return {
          label: entry.label,
          detail: off ? capabilityOffWords(capability!) : latest === null ? detailOf(entry.task) : `Last ran ${atWords(latest, now)}`,
          onSelect: () => onPick(entry.task),
        };
      })}
    />
  );
}

function detailOf(task: string): string {
  if (task === 'extract-curate') return 'Reads prompts Myco hasn’t read yet';
  if (task === 'canopy-map') return 'Brings the map up to the latest commit';
  return 'Reads the repository for what it holds';
}

export interface RunTaskConfirmProps {
  projectId: string;
  projectName: string;
  /** The task being confirmed, or null while none is. */
  task: string | null;
  onOpenChange: (open: boolean) => void;
  /** This week's work in the project, for the spend range. */
  week: readonly WorkOutcome[] | undefined;
  admin: boolean;
  now: number;
  onStarted: (task: string, answer: DispatchAnswer) => void;
}

/**
 * The confirmation every task passes through: what it will do, where it runs,
 * how long recent runs took, and what this week's runs of it spent. An admin
 * may start it fresh; a member never sees that choice.
 */
export function RunTaskConfirm({ projectId, projectName, task, onOpenChange, week, admin, now, onStarted }: RunTaskConfirmProps) {
  const entry = STARTABLE_TASKS.find((candidate) => candidate.task === task) ?? null;
  const dispatch = useDispatchTask(projectId);
  const capabilities = useCapabilities(projectId);
  const [fresh, setFresh] = useState(false);
  // One ask at a time: set before the dispatch goes out, so a second click in the same tick sends nothing.
  const asking = useRef(false);
  const close = (open: boolean) => {
    if (dispatch.isPending) return;
    if (!open) { dispatch.reset(); setFresh(false); }
    onOpenChange(open);
  };
  if (entry === null) return null;
  const capability = TASK_CAPABILITY[entry.task];
  const switchedOff = capability !== undefined && capabilities.data?.capabilities[capability] === false;
  const outcome = week?.find((candidate) => candidate.task === entry.task);
  const spend = spendWords(outcome?.spend, entry.noun, 'This week');
  const refusal = dispatch.error === null ? null : refusalOf(dispatch.error, now);
  const offCapability = refusal?.capability ?? (switchedOff ? capability! : null);
  return (
    <Dialog open={task !== null} onOpenChange={close}>
      <DialogContent title={`${entry.label}?`} description={entry.does(projectName)} hideClose data-run-task-confirm={entry.task}>
        {offCapability !== null ? (
          <p role="alert" className="flex flex-col gap-s1 t-small text-ink-2" data-capability-off="">
            <span className="font-medium text-bad">{capabilityOffWords(offCapability)}</span>
            {admin
              ? <Link to={`${projectPath(projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.capabilities}`} className="w-fit">Turn it on in Project settings →</Link>
              : <span>An admin can turn it on in the project’s settings.</span>}
          </p>
        ) : (
          <>
            <p className="t-small text-ink-2">It runs on the first free machine that has an agent signed in.{spend.took === null ? '' : ` ${spend.took}`}</p>
            <p className="rounded-control border border-line bg-warn-bg px-s3 py-s2 t-small text-ink-2" data-spend="">
              <span className="font-medium text-ink">This spends model tokens.</span>{' '}
              {spend.spend ?? `No ${entry.noun} finished this week, so there’s no recent spend to go by.`}
            </p>
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
              disabled={refusal?.final === true}
              onClick={() => {
                if (asking.current) return;
                asking.current = true;
                dispatch.mutate({ task: entry.task, fresh: admin && fresh }, {
                  onSuccess: (answer) => { onStarted(entry.task, answer); close(false); },
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

/** A dispatch's refusal in the reader's words, the capability it names when it names one, and whether trying again now can help. */
function refusalOf(error: Error, now: number): { words: string; capability: string | null; final: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 429 && isDailyLimit(error.body)) return { words: dailyLimitWords(error.body, now), capability: null, final: true };
    if (error.status === 409 && isCapabilityOff(error.body)) return { words: capabilityOffWords(error.body.capability), capability: error.body.capability, final: true };
    if (error.status === 403 && isFreshNeedsAdmin(error.body)) return { words: 'Only an admin can start a task fresh.', capability: null, final: false };
    return { words: error.detail ?? `The server couldn’t start it (${error.status}). Try again in a moment.`, capability: null, final: false };
  }
  return { words: 'Couldn’t reach the server. Try again in a moment.', capability: null, final: false };
}
