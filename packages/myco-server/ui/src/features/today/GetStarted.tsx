import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ActionLink, Button, Card, EmptyState, HealthDot } from '../../design';
import { useSetupProgress } from '../../hooks/use-setup-progress';
import { setupChecks } from '../../lib/setup-progress';
import { useProjects } from '../../hooks/use-projects';
import { repositoryNeededWords } from './words';
import { PEOPLE_PATH, RUNNERS_PATH } from '../../routes/nav';
import type { SetupProgress } from './wire';

const SETUP_COMMAND = 'myco setup';
const STATE_LABELS = { unchecked: 'Unchecked', done: 'Done', next: 'Next', later: 'Later' };
type Item = { id: string; title: string; done: boolean; nextAction?: ReactNode; to?: string; link?: string; warn?: boolean };

export function setupItems(progress: SetupProgress | undefined, admin: boolean, projectName: (id: string) => string | null = () => null): Item[] {
  const checks = setupChecks(progress, admin);
  const origin = window.location.origin;
  const joinCommand = `${SETUP_COMMAND} --join ${origin}`;
  const runnerCommand = `${SETUP_COMMAND} --runner ${origin}`;
  const items: Omit<Item, 'done'>[] = [
    { id: 'machine', title: 'Sign a machine in',
      nextAction: <>On your computer, run <code>{joinCommand}</code>.</>, to: PEOPLE_PATH, link: 'Add a machine' },
    { id: 'project', title: 'Connect a project',
      nextAction: <>Start your agent in a repository on a signed-in machine; it joins on its own, or run <code>myco member join</code>.</>,
      to: '/projects', link: 'Projects' },
    { id: 'capture', title: 'Capture a live session',
      nextAction: <>Start a session in your agent in that repository. Imported history doesn’t count here.</>, to: '/sessions', link: 'Sessions' },
  ];
  const definitions: Omit<Item, 'done'>[] = admin ? [
    { id: 'owner', title: progress?.viewerIsOwner ? 'You’re the owner' : 'Owner linked',
      nextAction: <>On the computer that created your Myco, run <code>myco server setup-owner</code>.</> },
    { id: 'sign-in', title: 'Sign-in working',
      nextAction: <>Sign in to this dashboard with your connected GitHub account.</> },
    ...items,
    { id: 'runner', title: 'Add a runner',
      nextAction: <>On an always-on machine, run <code>{runnerCommand}</code>.
        {(progress?.legacyWorkers ?? 0) > 0 && <> A machine runs Myco’s work with an older setup; register a runner to replace it.</>}</>,
      to: RUNNERS_PATH, link: 'Runners', warn: progress?.queuedWithoutRunner },
    ...(progress?.repositoriesNeeded ?? []).map(({ projectId }) => {
      const words = repositoryNeededWords(projectId, projectName(projectId));
      return { id: `repository:${projectId}`, title: words.title, nextAction: words.detail, to: words.action!.to, link: words.action!.label };
    }),
    { id: 'work', title: 'See Myco’s work in the last 31 days',
      nextAction: <>Myco’s work starts after a live session and a ready runner.</>, to: '/work', link: 'Myco’s work' },
  ] : [items[0]!, { id: 'project-capture', title: 'Connect a project and capture a session',
    nextAction: <>Start a session in your agent in that repository. It connects the project and captures the session.</>, to: '/sessions', link: 'Sessions' }];
  return definitions.map(item => ({ ...item, done: checks[item.id] === true }));
}

/** One observed checklist, shared by Today and the Projects empty state. */
export function GetStarted({ emptyState = false }: { emptyState?: boolean }) {
  const progress = useSetupProgress();
  const projects = useProjects();
  const { admin } = progress;
  const location = useLocation();
  if (progress.hidden) return emptyState
    ? <EmptyState title="No projects yet." action={<Button size="sm" variant="ghost" onClick={progress.show}>Show Get started</Button>} />
    : null;
  if (progress.complete) return null;
  const facts = progress.error ? undefined : progress.data;
  const items = setupItems(facts, admin, id => projects.data?.projects.find(project => project.projectId === id)?.name ?? null);
  const next = items.find(item => !item.done)?.id;
  const unchecked = facts === undefined;
  const rows = items.map(item => {
    const state = unchecked ? 'unchecked' : item.done ? 'done' : item.id === next ? 'next' : 'later';
    return { ...item, to: item.to === location.pathname ? undefined : item.to, state, stateLabel: STATE_LABELS[state] };
  });
  return (
    <Card className="flex flex-col gap-s3" data-get-started="">
      <div className="flex flex-wrap items-baseline justify-between gap-s2">
        <h2 className="t-h2 text-ink">Get started</h2>
        <Button size="sm" variant="ghost" onClick={progress.dismiss}>Hide for now</Button>
      </div>
      {unchecked && <p className="t-small text-muted" role={progress.error ? 'alert' : 'status'}>
        {progress.isPending && !progress.error ? 'Checking setup…' : 'Couldn’t check just now.'}
        {Boolean(progress.error) && <Button size="sm" variant="ghost" onClick={() => void progress.refetch()}>Retry</Button>}
      </p>}
      <ol aria-label="Get started checklist" className="flex flex-col gap-s3">
        {rows.map(item => <li key={item.id} className="flex flex-col gap-s1" data-setup-item={item.id} data-state={item.state}>
            <div className="flex items-center gap-s2 t-small text-ink">
              <HealthDot tone={item.done ? 'ok' : item.warn || item.state === 'next' ? 'warn' : 'faint'} className={item.done ? 'ring-2 ring-ok-bg rounded-pill' : undefined} label={item.stateLabel} />
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
