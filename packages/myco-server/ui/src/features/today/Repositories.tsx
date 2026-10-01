import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, Disclosure, HealthDot, Select } from '../../design';
import { useConnectUncaptured } from '../../hooks/use-uncaptured';
import { ApiError } from '../../lib/api';
import type { UncapturedRootItem } from './wire';
import { count, listed, repositoryMachine, repositoryWords } from './words';

const TONE_LABEL = { warn: 'Not captured yet', bad: 'Work there isn’t being kept' } as const;

/** The project choice that leaves it to Myco: the project its remote belongs to, or a new one. */
const MYCO_CHOOSES = 'myco-chooses';

/** A project a repository can be connected to. */
export interface ConnectTarget {
  projectId: string;
  name: string;
}

/** What a viewer is told once a repository is connected: its machine picks it up at the next agent session there. */
export function connectedWords(item: UncapturedRootItem, viewerId: string | null): string {
  const machine = repositoryMachine(item, viewerId);
  return `${item.label} is connected. ${machine.charAt(0).toUpperCase()}${machine.slice(1)} starts capturing it at the next agent session there.`;
}

function refusalWords(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Its remote already belongs to another project. Choose that project, or let Myco choose.';
    if (error.status === 404) return 'It’s no longer waiting: it was connected already, or its machine left.';
    if (error.status === 400 && /only on the dashboard/.test(JSON.stringify(error.body))) {
      return 'New projects are started only by an admin here. Choose a project for it.';
    }
    if (error.status === 400) return 'Myco couldn’t connect it to that project. Choose another.';
    return `Myco couldn’t connect it (${error.status}).`;
  }
  return 'Couldn’t reach Myco. Try again.';
}

/** One repository a member's machine is not capturing yet: the problem, why, what is kept meanwhile, and a way to connect it. */
export function RepositoryItem({ item, now, viewerId, onConnect }: {
  item: UncapturedRootItem; now: number; viewerId: string | null; onConnect: (item: UncapturedRootItem) => void;
}) {
  const words = repositoryWords(item, now, viewerId);
  return (
    <li className="flex gap-s3 border-t border-line pt-s3 first:border-t-0 first:pt-0" data-needs-you-item={words.tone} data-repository="">
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={words.tone} label={TONE_LABEL[words.tone]} /></span>
      <div className="flex min-w-0 flex-col gap-s1">
        <p className="t-body font-medium text-ink break-words">{words.title}</p>
        <p className="t-small text-muted">{words.detail} {words.held}</p>
        <p className="t-meta text-faint">{words.seen}</p>
        <div>
          <Button size="sm" onClick={() => onConnect(item)}>Connect {item.label}</Button>
        </div>
      </div>
    </li>
  );
}

/** Whether any of `items` has a machine that stopped keeping what its agents do there. */
export const losingWork = (items: readonly UncapturedRootItem[]): boolean => items.some((item) => item.held !== 'held');

/** How many of a group's repositories are losing work, as a sentence to follow their names, or nothing when none is. */
function losingWords(losing: number, of: number): string {
  if (losing === 0) return '';
  const which = losing < of ? `${losing} of them` : of === 2 ? 'both' : 'all of them';
  return ` Work in ${which} isn’t being kept.`;
}

/** The title "Needs you" gives two or more repositories Myco isn't capturing yet, as one line. */
export const repositoriesTitle = (items: readonly UncapturedRootItem[]): string => `${count(items.length, 'repository', 'repositories')} aren’t being captured yet`;

/**
 * Two or more repositories Myco isn't capturing yet, as one thing that needs the viewer: their names, whether any
 * machine has stopped keeping work, and each one, with its way to connect, a step away.
 */
export function RepositoryGroup({ items, now, viewerId, onConnect }: {
  items: readonly UncapturedRootItem[]; now: number; viewerId: string | null; onConnect: (item: UncapturedRootItem) => void;
}) {
  const tone = losingWork(items) ? 'bad' : 'warn';
  const losing = items.filter((item) => item.held !== 'held').length;
  return (
    <li className="flex gap-s3 border-t border-line pt-s3 first:border-t-0 first:pt-0" data-needs-you-item={tone} data-repositories="">
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={tone} label={TONE_LABEL[tone]} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <p className="t-body font-medium text-ink">{repositoriesTitle(items)}</p>
        <p className="t-small text-muted break-words">
          {listed(items.map((item) => item.label))}.{losingWords(losing, items.length)} Connect each to a project, or let Myco choose.
        </p>
        <Disclosure summary="See each">
          <ul className="flex flex-col gap-s3 pt-s1" aria-label="Repositories not captured yet">
            {items.map((item) => <RepositoryItem key={`${item.machineId}:${item.rootKey}`} item={item} now={now} viewerId={viewerId} onConnect={onConnect} />)}
          </ul>
        </Disclosure>
      </div>
    </li>
  );
}

/**
 * Connect a repository: to a project the viewer picks, or to the one Myco finds by its remote, else a new one named
 * after its folder. Its machine joins at the next agent session there.
 */
export function ConnectDialog({ item, viewerId, projects, onClose, onConnected }: {
  item: UncapturedRootItem | null;
  viewerId: string | null;
  projects: readonly ConnectTarget[];
  onClose: () => void;
  onConnected: (item: UncapturedRootItem) => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {item !== null && <ConnectBody key={`${item.machineId}:${item.rootKey}`} item={item} viewerId={viewerId} projects={projects} onClose={onClose} onConnected={onConnected} />}
    </Dialog>
  );
}

function ConnectBody({ item, viewerId, projects, onClose, onConnected }: {
  item: UncapturedRootItem; viewerId: string | null; projects: readonly ConnectTarget[]; onClose: () => void; onConnected: (item: UncapturedRootItem) => void;
}) {
  const connect = useConnectUncaptured();
  const machine = repositoryMachine(item, viewerId);
  const mycoChooses = item.remote === null
    ? `A new project named ${item.label}`
    : `The project that holds ${item.remote}, or a new one named ${item.label}`;
  // Where only an admin starts projects, a project to join is the choice that works for everyone.
  const [choice, setChoice] = useState<string>(item.reason === 'auto_create_off' && projects.length > 0 ? projects[0]!.projectId : MYCO_CHOOSES);
  const options = [{ value: MYCO_CHOOSES, label: mycoChooses, short: item.remote === null ? 'A new project' : 'Let Myco choose' }, ...projects.map((p) => ({ value: p.projectId, label: p.name }))];
  const submit = () => connect.mutate(
    { item, projectId: choice === MYCO_CHOOSES ? null : choice },
    { onSuccess: () => { onConnected(item); onClose(); } },
  );
  return (
    <DialogContent title={`Connect ${item.label}`} description={`${machine.charAt(0).toUpperCase()}${machine.slice(1)} starts capturing it at the next agent session there, and sends what it kept.`}>
      <form className="flex flex-col gap-s3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="flex flex-col gap-s2">
          <span className="t-body font-medium text-ink">Project</span>
          <Select label="Project" value={choice} onValueChange={setChoice} options={options} />
        </div>
        {connect.error !== null && <p role="alert" className="t-small text-bad">{refusalWords(connect.error)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={connect.isPending}>Connect</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
