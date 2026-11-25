import { RunTaskConfirm } from '../work/RunTask';
import { useState, type ReactNode } from 'react';
import { ActionLink, Button, Card, Disclosure, HealthDot, errorWords, Skeleton, ReadState } from '../../design';
import { settingsRefusalText, useCapabilities, useSettingsActions } from '../../hooks/use-settings';
import { ConnectDialog, connectedWords, losingWork, RepositoryGroup, RepositoryItem, repositoriesTitle, type ConnectTarget } from './Repositories';
import { needsItems, serverItemKey, serverItemWords, type ServerItemsRead } from './server-items';
import { useTaskDescriptions } from '../../hooks/use-tasks';
import { CAPABILITY_WORDS } from '../admin/project/Capabilities';
import { retrying, type AttentionAnswer, type AttentionItem, type UncapturedRootItem } from './wire';
import { ATTENTION_CHECKS, attentionWords, listed, repositoryWords, type Decline, type NeedsYouWords } from './words';

const TONE_LABEL = { warn: 'Needs attention', bad: 'Failing' } as const;

/** One thing that needs an administrator: a dot, the problem in one line, the detail in one more, and one way to act. */
export function NeedsYouItem({ tone, words }: { tone: AttentionItem['tone']; words: NeedsYouWords }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <li className="flex gap-s3 border-t border-line pt-s3 first:border-t-0 first:pt-0" data-needs-you-item={tone}>
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={tone} label={TONE_LABEL[tone]} /></span>
      <div className="flex min-w-0 flex-col gap-s1">
        <p className="t-body font-medium text-ink">{words.title}</p>
        <p className="t-small text-muted">{words.detail}</p>
        {words.retryTask !== undefined && <>
          <Button size="sm" onClick={() => setRetrying(true)}>Try now</Button>
          <RunTaskConfirm projectId={words.retryTask.projectId} task={retrying ? words.retryTask.task : null} admin now={Date.now()} onOpenChange={setRetrying}
            onStarted={() => { setRetrying(false); }} />
        </>}
        {(words.action !== null || words.decline !== undefined) && <div className="flex flex-wrap items-center gap-x-s4 gap-y-s1">
          {words.action !== null && (
            <ActionLink to={words.action.to}>
              {words.action.label} →
            </ActionLink>
          )}
          {words.decline !== undefined && <DeclineControl decline={words.decline} />}
        </div>}
      </div>
    </li>
  );
}

/** The way to say no to an item: a link to the setting that raises it, or a capability turned off for its project here. */
function DeclineControl({ decline }: { decline: Decline }) {
  if ('to' in decline) return <ActionLink to={decline.to}>{decline.label} →</ActionLink>;
  if ('turnOff' in decline) return <TurnOff label={decline.label} {...decline.turnOff} />;
  return <TurnOffTask {...decline.turnOffTask} />;
}

/** Turns off, for one project, the capability that gates a failing task, named for that capability; nothing for a task none gates. */
function TurnOffTask({ projectId, task, projectName }: { projectId: string; task: string; projectName: string }) {
  const tasks = useTaskDescriptions(null);
  const capability = tasks.data?.tasks.find((entry) => entry.task === task)?.capability ?? null;
  if (tasks.isError) return <p role="alert" className="t-small text-muted">Couldn’t read which switch runs this here.</p>;
  if (capability === null) return null;
  const words = (CAPABILITY_WORDS[capability]?.label ?? capability).toLowerCase();
  return <TurnOff label={`Turn ${words} off here`} projectId={projectId} capability={capability} done={`${words.charAt(0).toUpperCase()}${words.slice(1)} is off for ${projectName}.`} />;
}

/**
 * Turns one capability off for one project. Its revision is the one this page read, and zero for a switch never
 * changed, as the project's own settings save it; a failed read or a refusal says so.
 */
function TurnOff({ label, projectId, capability, done }: { label: string; projectId: string; capability: string; done: string }) {
  const caps = useCapabilities(projectId);
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  if (actions.setCapability.isSuccess) return <p role="status" className="t-small text-muted">{done}</p>;
  if (caps.isError) return <p role="alert" className="t-small text-muted">Couldn’t read this project’s switches: {settingsRefusalText(caps.error)}</p>;
  const revision = caps.data === undefined ? undefined : caps.data.capabilityRevisions[capability] ?? 0;
  return <>
    <Button size="sm" variant="ghost" disabled={revision === undefined} pending={actions.setCapability.isPending}
      onClick={() => { setError(null); actions.setCapability.mutate({ projectId, capability, enabled: false, revision: revision! }, { onError: (err) => setError(settingsRefusalText(err)) }); }}>
      {label}
    </Button>
    {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
  </>;
}

/** The repositories a viewer's machines, or as an admin any machine, are not capturing yet. */
export interface RepositoriesRead {
  items: UncapturedRootItem[] | undefined;
  pending: boolean;
  error: unknown;
}

export interface NeedsYouProps {
  /** The list's heading; "Needs you" where none is given. */
  title?: string;
  /** Whether the viewer is asked about the server's own health: an admin is, any other member is not. */
  admin: boolean;
  answer: AttentionAnswer | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  repositories: RepositoriesRead;
  /** What the dashboard reads beside the attention answer: store checks, stored keys and automatic backups; an admin's alone. */
  server: ServerItemsRead;
  viewerId: string | null;
  /** The projects a repository can be connected to. */
  projects: readonly ConnectTarget[];
  now: number;
  projectName: (projectId: string) => string | null;
}

interface Row {
  key: string;
  tone: AttentionItem['tone'];
  title: string;
  render: (connect: (item: UncapturedRootItem) => void) => ReactNode;
}

/**
 * How many things need the viewer: each attention item, each item read beside it, and the repositories their machines
 * are not capturing as one. The Needs you list and the count beside Health in the nav both say this number.
 */
export function needsYouCount(answer: AttentionAnswer | undefined, repositories: readonly UncapturedRootItem[] | undefined, server: ServerItemsRead['items'] = []): number {
  const items = needsItems(needsPerson(answer), server);
  return items.attention.length + items.server.length + ((repositories?.length ?? 0) > 0 ? 1 : 0);
}

/** The attention items a person must act on: those Myco still tries again by itself are Myco's work, stuck or failing. */
export const needsPerson = (answer: AttentionAnswer | undefined): AttentionItem[] => (answer?.items ?? []).filter((item) => !retrying(item));

function rowsOf({ admin, answer, repositories, server, now, projectName, viewerId }: NeedsYouProps): Row[] {
  const items = needsItems(needsPerson(answer), server.items);
  const attention = items.attention.map((item, index): Row => {
    const words = attentionWords(item, now, projectName);
    return { key: `${item.kind}:${index}`, tone: item.tone, title: words.title, render: () => <NeedsYouItem key={`${item.kind}:${index}`} tone={item.tone} words={words} /> };
  });
  const read = items.server.map((item): Row => {
    const words = serverItemWords(item);
    return { key: serverItemKey(item), tone: item.tone, title: words.title, render: () => <NeedsYouItem key={serverItemKey(item)} tone={item.tone} words={words} /> };
  });
  const roots = repositories.items ?? [];
  // One repository is its own line; more are one line that opens to each, so a machine with many never floods the list.
  const waiting: Row[] = roots.length === 0 ? [] : roots.length === 1
    ? [{ key: 'repository', tone: repositoryWords(roots[0]!, now, viewerId).tone, title: repositoryWords(roots[0]!, now, viewerId).title, render: (connect) => <RepositoryItem key="repository" item={roots[0]!} now={now} viewerId={viewerId} admin={admin} onConnect={connect} /> }]
    : [{ key: 'repositories', tone: losingWork(roots) ? 'bad' : 'warn', title: repositoriesTitle(roots), render: (connect) => <RepositoryGroup key="repositories" items={roots} now={now} viewerId={viewerId} admin={admin} onConnect={connect} /> }];
  return [...attention, ...read, ...waiting];
}

/** What could not be read, and what is still being read, in quiet lines, so a short list is never taken for all clear. */
function Unchecked({ props }: { props: NeedsYouProps }) {
  const names = [...new Set([...(props.answer?.unavailable ?? []).map((kind) => ATTENTION_CHECKS[kind]), ...props.server.unchecked])];
  if (props.repositories.error) names.push('repositories');
  const checking = [...(props.admin && props.pending ? ['the server’s own checks'] : []), ...(props.admin ? props.server.checking : []), ...(props.repositories.pending ? ['repositories'] : [])];
  return <>
    {names.length > 0 && <p className="t-small text-muted">Couldn’t check {listed(names)} just now.</p>}
    {checking.length > 0 && <p role="status" className="t-small text-muted">Still checking {listed(checking)}…</p>}
  </>;
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const words = errorWords(error);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-muted">
      <span>Couldn’t check what needs you: {words.title.replace(/\.$/, '').toLowerCase()}.</span>
      {words.retry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** Connecting a repository from "Needs you": the one being connected, and what the viewer is told once it is. */
function useConnecting(viewerId: string | null) {
  const [target, setTarget] = useState<UncapturedRootItem | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return {
    target,
    done,
    open: (item: UncapturedRootItem) => { setDone(null); setTarget(item); },
    close: () => setTarget(null),
    connected: (item: UncapturedRootItem) => setDone(connectedWords(item, viewerId)),
  };
}

function Connected({ words }: { words: string | null }) {
  if (words === null) return null;
  return (
    <p role="status" className="flex items-center gap-s2 t-small text-muted" data-connected="">
      <HealthDot tone="ok" label="Connected" />
      <span>{words}</span>
    </p>
  );
}

/**
 * Whether nothing the viewer is shown has been read yet: a member is never asked about the server's own health. Once
 * any read answers, its rows show and the rest are named as still being checked, so the list and the count beside
 * Health always say the same.
 */
const waiting = ({ admin, pending, repositories, server }: NeedsYouProps): boolean =>
  repositories.pending && (!admin || (pending && server.items.length === 0));

/**
 * Whether there is anything to show the viewer at all: an admin always has the panel; a member their repositories, or
 * that they could not be read, so a failed read is never taken for all clear.
 */
function shown(props: NeedsYouProps, rows: readonly Row[], connectedLine: string | null): boolean {
  return props.admin || rows.length > 0 || connectedLine !== null || Boolean(props.repositories.error);
}

/** Failed refreshes retain the last checked facts while naming every unread source. */
function ReadChecks({ props }: { props: NeedsYouProps }) {
  return <>
    {props.admin && Boolean(props.error) && <ReadState data={props.answer} pending={false} error={props.error} onRetry={props.onRetry} label="what needs you">{() => null}</ReadState>}
    {Boolean(props.repositories.error) && <ReadState data={props.repositories.items} pending={false} error={props.repositories.error} onRetry={props.onRetry} label="repositories">{() => null}</ReadState>}
    <Unchecked props={props} />
    {((props.answer?.unavailable.length ?? 0) > 0 || props.server.unchecked.length > 0) && <Button size="sm" variant="ghost" onClick={props.onRetry}>Retry</Button>}
  </>;
}

function EmptyChecks({ props, connected, dialog, phone = false }: { props: NeedsYouProps; connected: string | null; dialog: ReactNode; phone?: boolean }) {
  const reading = (props.admin && (props.pending || props.server.checking.length > 0)) || props.repositories.pending;
  const incomplete = (props.admin && Boolean(props.error)) || Boolean(props.repositories.error) || (props.answer?.unavailable.length ?? 0) > 0 || props.server.unchecked.length > 0;
  const heading = incomplete ? 'Some checks could not be read' : reading ? 'Still checking' : 'Nothing needs you';
  return <Card data-needs-you="" className={phone ? 'flex flex-col gap-s2 px-s4 py-s3' : 'flex flex-col gap-s2'}>
    <div className="flex items-center gap-s3">
      {phone && <HealthDot tone={incomplete || reading ? 'faint' : 'ok'} label={incomplete ? 'Not every check could be read' : reading ? 'Still checking' : 'All clear'} />}
      <h2 className={phone ? 't-body font-medium text-ink' : 't-h2 text-ink'}>{heading}</h2>
    </div>
    <ReadChecks props={props} />
    <Connected words={connected} />{dialog}
  </Card>;
}

/** "Needs you" on a wide screen: every item, or one line when there is nothing. */
export function NeedsYouPanel(props: NeedsYouProps) {
  const { admin, answer, error, onRetry, viewerId, projects } = props;
  const connecting = useConnecting(viewerId);
  if (waiting(props)) {
    if (!admin) return null;
    return (
      <Card role="status" aria-label="Checking what needs you" className="flex flex-col gap-s3" data-needs-you="">
        <Skeleton className="h-s5 w-2/5" />
        <Skeleton className="h-s4 w-4/5" />
      </Card>
    );
  }
  const rows = rowsOf(props);
  if (!shown(props, rows, connecting.done)) return null;
  const dialog = <ConnectDialog item={connecting.target} viewerId={viewerId} projects={projects} onClose={connecting.close} onConnected={connecting.connected} />;
  if (admin && answer === undefined && rows.length === 0) {
    return <Card data-needs-you=""><Failed error={error} onRetry={onRetry} /></Card>;
  }
  if (rows.length === 0) return <EmptyChecks props={props} connected={connecting.done} dialog={dialog} />;

  return (
    <Card className="flex flex-col gap-s3" data-needs-you="">
      <div className="flex items-baseline gap-s2">
        <h2 className="t-h2 text-ink">{props.title ?? 'Needs you'}</h2>
        <span className="t-small text-muted">{needsYouCount(props.answer, props.repositories.items, props.server.items)}</span>
      </div>
      <ReadChecks props={props} />
      <Connected words={connecting.done} />
      <ul className="flex flex-col gap-s3">
        {rows.map((row) => row.render(connecting.open))}
      </ul>
      {dialog}
    </Card>
  );
}

/** "Needs you" on a phone: one line at the top of the page that opens to the items. */
export function NeedsYouSummary(props: NeedsYouProps) {
  const { admin, answer, error, onRetry, viewerId, projects } = props;
  const connecting = useConnecting(viewerId);
  if (waiting(props)) return null;
  const rows = rowsOf(props);
  if (!shown(props, rows, connecting.done)) return null;
  const dialog = <ConnectDialog item={connecting.target} viewerId={viewerId} projects={projects} onClose={connecting.close} onConnected={connecting.connected} />;
  if (admin && answer === undefined && rows.length === 0) return <Card data-needs-you=""><Failed error={error} onRetry={onRetry} /></Card>;
  if (rows.length === 0) return <EmptyChecks props={props} connected={connecting.done} dialog={dialog} phone />;

  const worst = rows.some((row) => row.tone === 'bad') ? 'bad' : 'warn';
  const first = rows[0]!;
  return (
    <Card className="px-s4 py-s3" data-needs-you="">
      <ReadChecks props={props} />
      <Disclosure
        summary={(
          <span className="flex min-w-0 items-center gap-s3 text-left">
            <HealthDot tone={worst} label={TONE_LABEL[worst]} />
            <span className="flex min-w-0 flex-col">
              <span className="t-body font-medium text-ink">{rows.length === 1 ? '1 thing needs you' : `${rows.length} things need you`}</span>
              <span className="t-small font-normal text-muted">{first.title}{rows.length > 1 ? `, and ${rows.length - 1} more` : ''}</span>
            </span>
          </span>
        )}
      >
        <Connected words={connecting.done} />
        <ul className="flex flex-col gap-s3 pt-s2">
          {rows.map((row) => row.render(connecting.open))}
        </ul>
        </Disclosure>
      {dialog}
    </Card>
  );
}
