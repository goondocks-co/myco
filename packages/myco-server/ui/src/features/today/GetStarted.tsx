import { useState, type ReactNode } from 'react';
import { ActionLink, Button, Card, HealthDot } from '../../design';
import { useSetupProgress } from '../../hooks/use-setup-progress';
import { useIsAdmin } from '../../hooks/use-me';
import { PEOPLE_PATH, RUNNERS_PATH } from '../../routes/nav';
import type { SetupProgress } from './wire';

const SETUP_COMMAND = 'myco setup';
const STATE_LABELS = { unchecked: 'Unchecked', done: 'Done', next: 'Next', later: 'Later' };
const HIDDEN_KEY = 'myco:get-started:hidden';
type Item = { id: string; title: string; done: boolean; nextAction?: ReactNode; to?: string; link?: string; warn?: boolean };

export function setupItems(progress: SetupProgress | undefined, admin: boolean): Item[] {
  const items: Item[] = [
    { id: 'machine', title: 'Sign a machine in', done: (progress?.machines.signedIn ?? 0) > 0,
      nextAction: <>On your computer, run <code>{SETUP_COMMAND}</code> and choose Join.</>, to: PEOPLE_PATH, link: 'Add a machine' },
    { id: 'project', title: 'Connect a project', done: (progress?.projects ?? 0) > 0,
      nextAction: <>Start your agent in a repository on a signed-in machine; it joins on its own, or run <code>myco member join</code>.</>,
      to: '/projects', link: 'Projects' },
    { id: 'capture', title: 'Capture a live session', done: progress?.liveCapture === true,
      nextAction: <>Start a session in your agent in that repository. Imported history doesn’t count here.</>, to: '/sessions', link: 'Sessions' },
  ];
  return admin ? [
    { id: 'owner', title: progress?.viewerIsOwner ? 'You’re the owner' : 'Owner linked', done: progress?.ownerLinked === true,
      nextAction: <>On the computer that created your Myco, run <code>myco server setup-owner</code>.</> },
    { id: 'sign-in', title: 'Sign-in working', done: progress?.signInWorking === true,
      nextAction: <>Sign in to this dashboard with your connected GitHub account.</> },
    ...items,
    { id: 'runner', title: 'Add a runner', done: (progress?.runnersReady ?? 0) > 0,
      nextAction: <>On an always-on machine, run <code>{SETUP_COMMAND}</code> and choose Run Myco’s work.
        {(progress?.legacyWorkers ?? 0) > 0 && <> A machine runs Myco’s work with an older setup; register a runner to replace it.</>}</>,
      to: RUNNERS_PATH, link: 'Runners', warn: progress?.queuedWithoutRunner },
    { id: 'work', title: 'See Myco’s work in the last 31 days', done: progress?.workProduced === true,
      nextAction: <>Myco’s work starts after a live session and a ready runner.</>, to: '/work', link: 'Myco’s work' },
  ] : items;
}

/** One observed checklist, shared by Today and the Projects empty state. */
export function GetStarted() {
  const progress = useSetupProgress();
  const admin = useIsAdmin();
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === 'yes');
  if (hidden) return null;
  const facts = progress.error ? undefined : progress.data;
  const items = setupItems(facts, admin);
  const next = items.find(item => !item.done)?.id;
  const unchecked = facts === undefined;
  const rows = items.map(item => {
    const state = unchecked ? 'unchecked' : item.done ? 'done' : item.id === next ? 'next' : 'later';
    return { ...item, state, stateLabel: STATE_LABELS[state] };
  });
  return (
    <Card className="flex flex-col gap-s3" data-get-started="">
      <div className="flex flex-wrap items-baseline justify-between gap-s2">
        <h2 className="t-h2 text-ink">Get started</h2>
        <Button size="sm" variant="ghost" onClick={() => { localStorage.setItem(HIDDEN_KEY, 'yes'); setHidden(true); }}>Hide for now</Button>
      </div>
      {unchecked && <p className="t-small text-muted" role={progress.error ? 'alert' : 'status'}>
        {progress.isPending && !progress.error ? 'Checking setup…' : 'Couldn’t check just now.'}
        {Boolean(progress.error) && <Button size="sm" variant="ghost" onClick={() => void progress.refetch()}>Retry</Button>}
      </p>}
      <ol aria-label="Get started checklist" className="flex flex-col gap-s3">
        {rows.map(item => <li key={item.id} className="flex flex-col gap-s1" data-setup-item={item.id} data-state={item.state}>
            <div className="flex items-center gap-s2 t-small text-ink">
              <HealthDot tone={item.done ? 'ok' : item.warn ? 'warn' : 'faint'} label={item.stateLabel} />
              <span className="font-medium">{item.title}</span><span className="ml-auto t-caption text-muted">{item.stateLabel}</span>
            </div>
            {!item.done && <div className="t-small text-muted">{item.nextAction}
              {item.to && <span className="ml-s2"><ActionLink to={item.to}>{item.link}</ActionLink></span>}
            </div>}
          </li>)}
      </ol>
      {!admin && <p className="t-small text-muted">Myco’s work runs on machines an admin chooses.
        {facts?.queuedWithoutRunner && <> Work is waiting for an admin to add a runner.</>}</p>}
    </Card>
  );
}
