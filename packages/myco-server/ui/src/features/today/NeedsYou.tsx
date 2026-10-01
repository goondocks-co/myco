import { useState, type ReactNode } from 'react';
import { ActionLink, Button, Card, Disclosure, HealthDot, errorWords, Skeleton } from '../../design';
import { ConnectDialog, connectedWords, losingWork, RepositoryGroup, RepositoryItem, repositoriesTitle, type ConnectTarget } from './Repositories';
import type { AttentionAnswer, AttentionItem, UncapturedRootItem } from './wire';
import { ATTENTION_CHECKS, attentionWords, listed, repositoryWords, type NeedsYouWords } from './words';

const TONE_LABEL = { warn: 'Needs attention', bad: 'Failing' } as const;

/** One thing that needs an administrator: a dot, the problem in one line, the detail in one more, and one way to act. */
export function NeedsYouItem({ tone, words }: { tone: AttentionItem['tone']; words: NeedsYouWords }) {
  return (
    <li className="flex gap-s3 border-t border-line pt-s3 first:border-t-0 first:pt-0" data-needs-you-item={tone}>
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={tone} label={TONE_LABEL[tone]} /></span>
      <div className="flex min-w-0 flex-col gap-s1">
        <p className="t-body font-medium text-ink">{words.title}</p>
        <p className="t-small text-muted">{words.detail}</p>
        {words.action !== null && (
          <ActionLink to={words.action.to}>
            {words.action.label} →
          </ActionLink>
        )}
      </div>
    </li>
  );
}

/** The repositories a viewer's machines, or as an admin any machine, are not capturing yet. */
export interface RepositoriesRead {
  items: UncapturedRootItem[] | undefined;
  pending: boolean;
  error: unknown;
}

export interface NeedsYouProps {
  /** Whether the viewer is asked about the server's own health: an admin is, any other member is not. */
  admin: boolean;
  answer: AttentionAnswer | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  repositories: RepositoriesRead;
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

function rowsOf({ answer, repositories, now, projectName, viewerId }: NeedsYouProps): Row[] {
  const attention = (answer?.items ?? []).map((item, index): Row => {
    const words = attentionWords(item, now, projectName);
    return { key: `${item.kind}:${index}`, tone: item.tone, title: words.title, render: () => <NeedsYouItem key={`${item.kind}:${index}`} tone={item.tone} words={words} /> };
  });
  const items = repositories.items ?? [];
  // One repository is its own line; more are one line that opens to each, so a machine with many never floods the list.
  const waiting: Row[] = items.length === 0 ? [] : items.length === 1
    ? [{ key: 'repository', tone: repositoryWords(items[0]!, now, viewerId).tone, title: repositoryWords(items[0]!, now, viewerId).title, render: (connect) => <RepositoryItem key="repository" item={items[0]!} now={now} viewerId={viewerId} onConnect={connect} /> }]
    : [{ key: 'repositories', tone: losingWork(items) ? 'bad' : 'warn', title: repositoriesTitle(items), render: (connect) => <RepositoryGroup key="repositories" items={items} now={now} viewerId={viewerId} onConnect={connect} /> }];
  return [...attention, ...waiting];
}

/** What could not be read, in one quiet line, so an empty list is never taken for all clear. */
function Unchecked({ answer, repositories }: { answer: AttentionAnswer | undefined; repositories: RepositoriesRead }) {
  const names = [...new Set((answer?.unavailable ?? []).map((kind) => ATTENTION_CHECKS[kind]))];
  if (repositories.error) names.push('repositories');
  if (names.length === 0) return null;
  return <p className="t-small text-muted">Couldn’t check {listed(names)} just now.</p>;
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

/** Whether a read the viewer is shown is still on its way: a member is never asked about the server's own health. */
const waiting = ({ admin, pending, repositories }: NeedsYouProps): boolean => repositories.pending || (admin && pending);

/** Whether there is anything to show the viewer at all: an admin always has the panel, a member only their repositories. */
function shown(props: NeedsYouProps, rows: readonly Row[], connectedLine: string | null): boolean {
  return props.admin || rows.length > 0 || connectedLine !== null;
}

/** "Needs you" on a wide screen: every item, or one line when there is nothing. */
export function NeedsYouPanel(props: NeedsYouProps) {
  const { admin, answer, error, onRetry, repositories, viewerId, projects } = props;
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
  if (rows.length === 0) {
    return (
      <Card className="flex flex-col gap-s2" data-needs-you="">
        <h2 className="t-h2 text-ink">Nothing needs you</h2>
        <Connected words={connecting.done} />
        <Unchecked answer={answer} repositories={repositories} />
        {dialog}
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-s3" data-needs-you="">
      <div className="flex items-baseline gap-s2">
        <h2 className="t-h2 text-ink">Needs you</h2>
        <span className="t-small text-muted">{rows.length}</span>
      </div>
      {admin && answer === undefined && <Failed error={error} onRetry={onRetry} />}
      <Connected words={connecting.done} />
      <ul className="flex flex-col gap-s3">
        {rows.map((row) => row.render(connecting.open))}
      </ul>
      <Unchecked answer={answer} repositories={repositories} />
      {dialog}
    </Card>
  );
}

/** "Needs you" on a phone: one line at the top of the page that opens to the items. */
export function NeedsYouSummary(props: NeedsYouProps) {
  const { admin, answer, error, onRetry, repositories, viewerId, projects } = props;
  const connecting = useConnecting(viewerId);
  if (waiting(props)) return null;
  const rows = rowsOf(props);
  if (!shown(props, rows, connecting.done)) return null;
  const dialog = <ConnectDialog item={connecting.target} viewerId={viewerId} projects={projects} onClose={connecting.close} onConnected={connecting.connected} />;
  if (admin && answer === undefined && rows.length === 0) return <Card data-needs-you=""><Failed error={error} onRetry={onRetry} /></Card>;
  if (rows.length === 0) {
    return (
      <Card className="flex flex-col gap-s2 px-s4 py-s3" data-needs-you="">
        <div className="flex items-center gap-s3">
          <HealthDot tone="ok" label="All clear" />
          <h2 className="t-body font-medium text-ink">Nothing needs you</h2>
        </div>
        <Connected words={connecting.done} />
        {dialog}
      </Card>
    );
  }
  const worst = rows.some((row) => row.tone === 'bad') ? 'bad' : 'warn';
  const first = rows[0]!;
  return (
    <Card className="px-s4 py-s3" data-needs-you="">
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
        {admin && answer === undefined && <Failed error={error} onRetry={onRetry} />}
        <Connected words={connecting.done} />
        <ul className="flex flex-col gap-s3 pt-s2">
          {rows.map((row) => row.render(connecting.open))}
        </ul>
        <Unchecked answer={answer} repositories={repositories} />
      </Disclosure>
      {dialog}
    </Card>
  );
}
