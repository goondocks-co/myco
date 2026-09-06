import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Copy, Loader2, Sparkles, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { inlineLink } from '../ui/inline-link';
import { MetricCard } from '../ui/metric-card';
import { PageLoading } from '../ui/page-loading';
import { Panel } from '../ui/panel';
import { StatusDot } from '../ui/status-dot';
import { SubtabPill } from '../ui/subtab-pill';
import { Surface } from '../ui/surface';
import {
  blobUrl, memberName, PROMPT_ORIGINS, RENDERABLE_IMAGE_TYPES, runtimeName, TITLING_OUTCOME_TEXT, TITLING_WATCH_MS, useSession, useSessionChildren, useTitleSession, useTranscript, useTurns,
  type AttachmentRow, type ContextInjectionRow, type PlanRow, type SessionRow, type TurnRow,
} from '../../hooks/use-sessions';
import { useQueryClient } from '@tanstack/react-query';
import { useRun, useSpores } from '../../hooks/use-intelligence';
import { formatLabel, sporePreview, statusVariant } from '../spores/labels';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatBytes, formatCount, formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { NotFound } from '../../pages/NotFound';
import { PlanCard } from './PlanCard';
import { promptPreview } from './TurnCard';
import { TurnTimeline } from './TurnTimeline';

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'plans', label: 'Plans' },
  { id: 'spores', label: 'Spores' },
  { id: 'context', label: 'Context' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'transcript', label: 'Transcript' },
];
const TAB_IDS = new Set(TABS.map((t) => t.id));

/** How many of a session's spores the tab lists; the count above the list says how many there are. */
const SESSION_SPORE_LIMIT = 100;

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

export function SessionDetail({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const detail = useSession(projectId, sessionId);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = requested !== null && TAB_IDS.has(requested) ? requested : 'conversation';
  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    if (next === 'conversation') copy.delete('tab'); else copy.set('tab', next);
    setParams(copy, { replace: true });
  };
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
  return (
    <PageLoading isLoading={detail.isPending} error={detail.error} loadingText="Loading session…">
      {detail.data && (
        <div className="flex flex-col gap-5">
          <Header projectId={projectId} session={detail.data.session} />
          <div className="grid grid-cols-3 gap-3 xl:grid-cols-5">
            <MetricCard label="Prompts" value={detail.data.counts.prompts.toLocaleString()} tone="sage" />
            <MetricCard label="Tool calls" value={detail.data.counts.toolCalls.toLocaleString()} tone="ochre" />
            <MetricCard label="Responses" value={detail.data.counts.responses.toLocaleString()} tone="sage" />
            <MetricCard label="Plans" value={detail.data.counts.plans.toLocaleString()} />
            <MetricCard label="Attachments" value={detail.data.counts.attachments.toLocaleString()} />
          </div>
          <Metadata projectId={projectId} session={detail.data.session} />
          {detail.data.session.summary !== null && (
            <Panel padded title="Summary">
              <pre className="whitespace-pre-wrap break-words font-sans text-sm text-on-surface">{detail.data.session.summary}</pre>
            </Panel>
          )}
          <div className="min-w-0">
            <SubtabPill tabs={TABS} activeTab={tab} onTabChange={setTab} className="mb-4" />
            {tab === 'conversation' && <TurnTimeline projectId={projectId} sessionId={sessionId} promptCount={detail.data.counts.prompts} />}
            {tab === 'plans' && <Plans projectId={projectId} sessionId={sessionId} wanted={params.get('plan')} />}
            {tab === 'spores' && <Spores projectId={projectId} sessionId={sessionId} />}
            {tab === 'context' && <ContextInjections projectId={projectId} sessionId={sessionId} />}
            {tab === 'attachments' && <Attachments projectId={projectId} sessionId={sessionId} />}
            {tab === 'transcript' && <Transcript projectId={projectId} sessionId={sessionId} />}
          </div>
        </div>
      )}
    </PageLoading>
  );
}

function contextLabel(kind: string): string {
  if (kind === 'cortex') return 'Session start';
  if (kind === 'plan-nudge') return 'Plan reminder';
  if (kind.startsWith('cortex-compact:')) return `After compaction ${kind.slice('cortex-compact:'.length)}`;
  if (kind.startsWith('cortex:')) return `Subagent · ${kind.slice('cortex:'.length)}`;
  return kind;
}

function ContextInjections({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const context = useSessionChildren<ContextInjectionRow>(projectId, sessionId, 'context-injections');
  return (
    <PageLoading isLoading={context.isPending} error={context.error} loadingText="Loading context history…">
      <Panel title="Context history" padded>
        <p className="mb-4 font-sans text-sm text-on-surface-variant">Context the server prepared for this session. A record does not confirm that the coding agent received it.</p>
        {context.rows.length === 0 ? <p className="font-sans text-sm text-on-surface-variant">No session context recorded.</p> : (
          <ul className="divide-y divide-outline-variant/20" aria-label="Context records">
            {context.rows.map((record) => (
              <li key={record.kind} className="flex flex-wrap items-baseline justify-between gap-2 py-3 font-sans text-sm">
                <span className="break-words text-on-surface">{contextLabel(record.kind)}</span>
                <time dateTime={new Date(record.createdAt).toISOString()} className="text-xs text-on-surface-variant">{formatDateTime(record.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
        {context.hasMore && <button type="button" className={button} onClick={context.more}>Load more</button>}
      </Panel>
    </PageLoading>
  );
}

/**
 * Asks for the session's title and summary now, and says how it went. A run
 * writes them, so after a `dispatched` answer the page watches: the session is
 * read again every few seconds until its title or summary moves or the run
 * ends, bounded by the run's own timeout. The button stays focusable while it
 * works, so a keyboard user is never dropped to the page.
 */
function GenerateSummary({ projectId, sessionId, session }: { projectId: string; sessionId: string; session: SessionRow }) {
  const client = useQueryClient();
  const titling = useTitleSession(projectId, sessionId);
  // What the session carried when the ask was made; a change since is the summary landing.
  const [asked, setAsked] = useState<{ runId: string; title: string | null; summary: string | null; at: number } | null>(null);
  const landed = asked !== null && (session.title !== asked.title || session.summary !== asked.summary);
  const expired = asked !== null && Date.now() - asked.at > TITLING_WATCH_MS;
  // A miss before the container claims is kept, not retried; the timer below asks again.
  const run = useRun(projectId, asked?.runId ?? '', { enabled: asked !== null && !landed && !expired, retry: false });
  const runStatus = run.data?.run.status ?? null;
  const watching = asked !== null && !landed && !expired && (runStatus === null || !isTerminal(runStatus));
  const runId = asked?.runId ?? null;
  // One timer re-reads both the session and the run: a query's own interval pauses while the window is not focused, and a summary lands whether or not the reader is looking.
  useEffect(() => {
    if (!watching || runId === null) return;
    const timer = setInterval(() => {
      void client.invalidateQueries({ queryKey: ['session', projectId, sessionId] });
      void client.invalidateQueries({ queryKey: ['run', projectId, runId] });
    }, TITLING_POLL_MS);
    return () => clearInterval(timer);
  }, [watching, client, projectId, sessionId, runId]);

  const outcome = titling.data?.outcome;
  const note = titling.error ? 'The session could not be summarized right now'
    : landed ? 'Summary updated'
    : asked !== null && runStatus === 'failed' ? 'The summary run failed'
    : asked !== null && (expired || (runStatus !== null && isTerminal(runStatus))) ? 'The summary run ended without writing one'
    : outcome !== undefined ? TITLING_OUTCOME_TEXT[outcome] : null;
  const tone = landed ? 'text-primary' : 'text-tertiary';
  const busy = titling.isPending || watching;
  return (
    <div className="ml-auto flex flex-col items-end gap-1 self-start">
      <button
        type="button"
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (busy) return;
          setAsked(null);
          titling.mutate(undefined, {
            onSuccess: (answer) => {
              if ((answer.outcome === 'dispatched' || answer.outcome === 'queued') && answer.runId !== undefined) setAsked({ runId: answer.runId, title: session.title, summary: session.summary, at: Date.now() });
            },
          });
        }}
        className={cn(button, 'inline-flex h-8 items-center gap-2 font-medium', busy && 'opacity-60')}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {busy ? 'Writing summary…' : 'Generate summary'}
      </button>
      {note !== null && (
        <span className={cn('font-sans text-xs', tone)} role="status">
          {note}
          {asked !== null && !landed && <> · <Link to={`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(asked.runId)}`} className="underline">see the run</Link></>}
        </span>
      )}
    </div>
  );
}

/** How often the page asks again while a summary is being written. */
const TITLING_POLL_MS = 5_000;
const isTerminal = (status: string): boolean => status === 'completed' || status === 'failed' || status === 'skipped';

/** The session's name, state and the facts that identify the run, in one glance. */
function Header({ projectId, session }: { projectId: string; session: SessionRow }) {
  const open = session.endedAt === null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <StatusDot tone={open ? 'sage' : 'outline'} pulse={open} />
        <span className="font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Session · {open ? 'open' : 'ended'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="myco-display-lg m-0 min-w-0 text-on-surface">{session.label}</h2>
        {session.agent !== null && <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">{session.agent}</Badge>}
        {session.branch !== null && <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0">{session.branch}</Badge>}
        <GenerateSummary projectId={projectId} sessionId={session.sessionId} session={session} />
      </div>
      <div className="flex flex-wrap gap-4 font-sans text-sm text-on-surface-variant">
        <span>{memberName(session)}</span>
        {runtimeName(session) !== null && <span>{runtimeName(session)}</span>}
        <span title={formatDateTime(session.startedAt)}>Started {formatRelative(session.startedAt)}</span>
        {open
          ? <span>Last received {formatRelative(session.lastReceivedAt)}</span>
          : <span>Ran {formatDuration(session.startedAt, session.endedAt)}</span>}
      </div>
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const done = (next: 'copied' | 'failed') => { setState(next); setTimeout(() => setState('idle'), 1500); };
    if (!navigator.clipboard?.writeText) { done('failed'); return; }
    navigator.clipboard.writeText(value).then(() => done('copied'), () => done('failed'));
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={state === 'failed' ? 'Copy failed — check clipboard permissions' : 'Click to copy'}
      aria-label={`Copy ${label}`}
      aria-live="polite"
      className="flex min-w-0 items-center gap-1.5 text-left transition-colors hover:text-primary"
    >
      <span className="min-w-0 truncate font-mono text-xs text-on-surface">{value}</span>
      {state === 'copied' && <Check className="h-3 w-3 shrink-0 text-primary" />}
      {state === 'failed' && <X className="h-3 w-3 shrink-0 text-tertiary" />}
      {state === 'idle' && <Copy className="h-3 w-3 shrink-0 text-on-surface-variant/60" />}
    </button>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 border-b border-[var(--ghost-border)] py-1.5 last:border-0">
      <dt className="w-20 shrink-0 font-sans text-xs font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">{children}</dd>
    </div>
  );
}

/** The facts a reader copies or follows: the id, the machine, the path, the parent session. */
function Metadata({ projectId, session }: { projectId: string; session: SessionRow }) {
  return (
    <Surface level="low" className="overflow-hidden p-4">
      <div className="myco-eyebrow-sm mb-3">Metadata</div>
      <dl className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
        <MetaItem label="Session ID"><CopyValue value={session.sessionId} label="session id" /></MetaItem>
        <MetaItem label="Member">{memberName(session)}</MetaItem>
        <MetaItem label="Runtime">{[runtimeName(session), session.machineId].filter((v) => v !== null).join(' · ') || '—'}</MetaItem>
        <MetaItem label="Path">{session.originPath ?? '—'}</MetaItem>
        <MetaItem label="Started">{formatDateTime(session.startedAt)}</MetaItem>
        <MetaItem label={session.endedAt === null ? 'Last received' : 'Ended'}>{formatDateTime(session.endedAt ?? session.lastReceivedAt)}</MetaItem>
        {session.parentSessionId !== null && (
          <MetaItem label="Parent">
            <Link to={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.parentSessionId)}`} className={inlineLink}>
              {session.parentSessionId}{session.parentReason ? ` (${session.parentReason})` : ''}
            </Link>
          </MetaItem>
        )}
      </dl>
    </Surface>
  );
}

/** The session's plans as cards; a plan in progress, or the one a link names with `?plan=`, opens on arrival. */
function Plans({ projectId, sessionId, wanted }: { projectId: string; sessionId: string; wanted: string | null }) {
  const plans = useSessionChildren<PlanRow>(projectId, sessionId, 'plans');
  return (
    <PageLoading isLoading={plans.isPending} error={plans.error}>
      {plans.rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-[var(--ghost-border)] bg-surface-container-low/50">
          <span className="font-sans text-sm text-on-surface-variant">No plans captured in this session.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.rows.map((plan) => <PlanCard key={plan.planKey} projectId={projectId} sessionId={sessionId} plan={plan} defaultOpen={plan.status === 'in_progress' || plan.planKey === wanted} />)}
          {plans.hasMore && <button type="button" className={button} onClick={plans.more}>Load more</button>}
        </div>
      )}
    </PageLoading>
  );
}

/** The spores this session produced, newest first, each opening on the Spores page. Every status is listed — a spore another session has already replaced still came out of this one. */
function Spores({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const spores = useSpores(projectId, { session: sessionId, limit: SESSION_SPORE_LIMIT });
  const rows = spores.data?.spores ?? [];
  const total = spores.data?.total ?? 0;
  return (
    <PageLoading isLoading={spores.isPending} error={spores.error}>
      {rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-[var(--ghost-border)] bg-surface-container-low/50">
          <span className="font-sans text-sm text-on-surface-variant">No observations were saved from this session yet.</span>
        </div>
      ) : (
        <>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="myco-eyebrow-sm">{formatCount(total, 'spore')}</span>
          {total > rows.length && (
            <span className="font-sans text-xs text-on-surface-variant">The {rows.length} most recent are listed here.</span>
          )}
        </div>
        <ul className="flex flex-col gap-2" aria-label="Spores">
          {rows.map((spore) => (
            <li key={spore.id}>
              <Link
                to={`/p/${encodeURIComponent(projectId)}/spores/${encodeURIComponent(spore.id)}`}
                className="block rounded-lg border border-[var(--ghost-border)] px-3 py-2 transition-colors hover:bg-surface-container"
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="secondary" className="font-mono text-[10px]">{formatLabel(spore.observationType)}</Badge>
                  {spore.status !== 'active' && <Badge variant={statusVariant(spore.status)} className="font-mono text-[10px]">{formatLabel(spore.status)}</Badge>}
                  <span className="ml-auto font-mono text-[10px] text-on-surface-variant" title={formatDateTime(spore.createdAt)}>{formatRelative(spore.createdAt)}</span>
                </div>
                <p className="m-0 mt-1 truncate font-sans text-sm text-on-surface">{sporePreview(spore.content)}</p>
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}
    </PageLoading>
  );
}

interface AttachmentGroup { key: string; label: string; rows: AttachmentRow[]; /** The top-level turn the group opens, when it has one. */ turn: string | null }

/** The attachments a turn carries, grouped under the turn in turn order; those on prompts the timeline does not list on its own (steering prompts, later pages) share one group, and those the capture tied to no prompt sit last. */
export function attachmentGroups(rows: readonly AttachmentRow[], turns: readonly TurnRow[]): AttachmentGroup[] {
  const byPrompt = new Map<string | null, AttachmentRow[]>();
  for (const row of rows) byPrompt.set(row.promptId, [...(byPrompt.get(row.promptId) ?? []), row]);
  const groups: AttachmentGroup[] = [];
  for (const turn of turns) {
    const mine = byPrompt.get(turn.promptId);
    if (mine !== undefined) { groups.push({ key: turn.promptId, label: promptPreview(turn), rows: mine, turn: turn.promptId }); byPrompt.delete(turn.promptId); }
  }
  const untied = byPrompt.get(null) ?? [];
  byPrompt.delete(null);
  const other = [...byPrompt.values()].flat();
  if (other.length > 0) groups.push({ key: 'other', label: 'Other prompts in this session', rows: other, turn: null });
  if (untied.length > 0) groups.push({ key: 'none', label: 'Not tied to a prompt', rows: untied, turn: null });
  return groups;
}

function Attachments({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const attachments = useSessionChildren<AttachmentRow>(projectId, sessionId, 'attachments');
  const turns = useTurns(projectId, sessionId, PROMPT_ORIGINS);
  return (
    <PageLoading isLoading={attachments.isPending || turns.isPending} error={attachments.error ?? turns.error}>
      {attachments.rows.length === 0 ? (
        <p className="font-sans text-sm text-on-surface-variant">No attachments in this session.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {attachmentGroups(attachments.rows, turns.rows).map((group) => (
            <section key={group.key} aria-label={group.label} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="min-w-0 truncate font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">{group.label}</h3>
                {group.turn !== null && <Link to={`?turn=${encodeURIComponent(group.turn)}`} className={cn(inlineLink, 'shrink-0')}>Open the turn</Link>}
              </div>
              <ul className="grid gap-3 sm:grid-cols-2" aria-label={`Attachments of ${group.label}`}>
                {group.rows.map((a) => (
                  <li key={a.attachmentId} className="rounded-lg border border-outline-variant/20 p-3">
                    {RENDERABLE_IMAGE_TYPES.includes(a.mediaType) ? (
                      <img src={blobUrl(projectId, a.blobKey)} alt={a.description ?? a.attachmentId} className="max-h-64 w-auto rounded-md" />
                    ) : (
                      <a href={blobUrl(projectId, a.blobKey)} className={inlineLink}>Download {a.description ?? a.attachmentId}</a>
                    )}
                    <div className="mt-2 font-sans text-xs text-on-surface-variant">{a.mediaType} · {formatBytes(a.byteSize)} · {formatRelative(a.createdAt)}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {attachments.hasMore && <button type="button" className={button} onClick={attachments.more}>Load more</button>}
        </div>
      )}
    </PageLoading>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-outline-variant/10 py-1">
      <dt className="shrink-0 text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 truncate text-on-surface">{value ?? '—'}</dd>
    </div>
  );
}

/** The transcript's record and its segments, each a link; the bytes are never fetched here — a transcript runs to megabytes. */
function Transcript({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const transcript = useTranscript(projectId, sessionId);
  return (
    <PageLoading isLoading={transcript.isPending} error={transcript.error}>
      {transcript.data === null ? (
        <p className="font-sans text-sm text-on-surface-variant">No transcript captured.</p>
      ) : transcript.data && (
        <Panel title="Transcript" eyebrow={`${formatBytes(transcript.data.transcript.size)} · ${formatCount(transcript.data.transcript.segmentCount, 'segment')}`}>
          <dl className="grid gap-x-6 gap-y-1 font-sans text-sm sm:grid-cols-2">
            <Fact label="Agent" value={transcript.data.transcript.agent} />
            <Fact label="Path" value={transcript.data.transcript.originPath} />
            <Fact label="First received" value={formatDateTime(transcript.data.transcript.firstReceivedAt)} />
            <Fact label="Last received" value={formatDateTime(transcript.data.transcript.lastReceivedAt)} />
          </dl>
          <ul className="mt-3 flex flex-col gap-1" aria-label="Transcript segments">
            {transcript.data.segments.map((s) => (
              <li key={s.baseOffset} className="flex items-center gap-3 font-mono text-xs">
                <a href={blobUrl(projectId, s.blobKey)} target="_blank" rel="noreferrer" className={inlineLink}>bytes {s.baseOffset.toLocaleString()}–{(s.baseOffset + s.length).toLocaleString()}</a>
                <span className="text-on-surface-variant">{formatBytes(s.length)} · {formatRelative(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </PageLoading>
  );
}
