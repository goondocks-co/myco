import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import { Badge } from '../ui/badge';
import { MetricCard } from '../ui/metric-card';
import { PageLoading } from '../ui/page-loading';
import { Panel } from '../ui/panel';
import { StatusDot } from '../ui/status-dot';
import { SubtabPill } from '../ui/subtab-pill';
import { Surface } from '../ui/surface';
import {
  blobUrl, memberName, RENDERABLE_IMAGE_TYPES, runtimeName, useSession, useSessionChildren, useTranscript,
  type AttachmentRow, type PlanRow, type SessionRow,
} from '../../hooks/use-sessions';
import { ApiError } from '../../lib/api';
import { formatBytes, formatCount, formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { NotFound } from '../../pages/NotFound';
import { PlanCard } from './PlanCard';
import { TurnTimeline } from './TurnTimeline';

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'plans', label: 'Plans' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'transcript', label: 'Transcript' },
];
const TAB_IDS = new Set(TABS.map((t) => t.id));

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';
const link = 'font-sans text-xs text-primary underline';

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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
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
            {tab === 'conversation' && <TurnTimeline projectId={projectId} sessionId={sessionId} />}
            {tab === 'plans' && <Plans projectId={projectId} sessionId={sessionId} />}
            {tab === 'attachments' && <Attachments projectId={projectId} sessionId={sessionId} />}
            {tab === 'transcript' && <Transcript projectId={projectId} sessionId={sessionId} />}
          </div>
        </div>
      )}
    </PageLoading>
  );
}

/** The session's name, state and the facts that identify the run, in one glance. */
function Header({ session }: { projectId: string; session: SessionRow }) {
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      title="Click to copy"
      aria-label={`Copy ${label}`}
      className="flex min-w-0 items-center gap-1.5 text-left transition-colors hover:text-primary"
    >
      <span className="min-w-0 truncate font-mono text-xs text-on-surface">{value}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <Copy className="h-3 w-3 shrink-0 text-on-surface-variant/60" />}
    </button>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-[var(--ghost-border)] py-1.5 last:border-0">
      <dt className="w-20 shrink-0 font-sans text-xs font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono text-xs text-on-surface">{children}</dd>
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
            <Link to={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.parentSessionId)}`} className={link}>
              {session.parentSessionId}{session.parentReason ? ` (${session.parentReason})` : ''}
            </Link>
          </MetaItem>
        )}
      </dl>
    </Surface>
  );
}

function Plans({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const plans = useSessionChildren<PlanRow>(projectId, sessionId, 'plans');
  return (
    <PageLoading isLoading={plans.isPending} error={plans.error}>
      {plans.rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-[var(--ghost-border)] bg-surface-container-low/50">
          <span className="font-sans text-sm text-on-surface-variant">No plans captured in this session.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.rows.map((plan) => <PlanCard key={plan.planKey} projectId={projectId} plan={plan} defaultOpen={plan.status === 'in_progress'} />)}
          {plans.hasMore && <button type="button" className={button} onClick={plans.more}>Load more</button>}
        </div>
      )}
    </PageLoading>
  );
}

function Attachments({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const attachments = useSessionChildren<AttachmentRow>(projectId, sessionId, 'attachments');
  return (
    <PageLoading isLoading={attachments.isPending} error={attachments.error}>
      {attachments.rows.length === 0 ? (
        <p className="font-sans text-sm text-on-surface-variant">No attachments in this session.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Attachments">
          {attachments.rows.map((a) => (
            <li key={a.attachmentId} className="rounded-lg border border-outline-variant/20 p-3">
              {RENDERABLE_IMAGE_TYPES.includes(a.mediaType) ? (
                <img src={blobUrl(projectId, a.blobKey)} alt={a.description ?? a.attachmentId} className="max-h-64 w-auto rounded-md" />
              ) : (
                <a href={blobUrl(projectId, a.blobKey)} className={link}>Download {a.description ?? a.attachmentId}</a>
              )}
              <div className="mt-2 font-sans text-xs text-on-surface-variant">{a.mediaType} · {formatBytes(a.byteSize)} · {formatRelative(a.createdAt)}</div>
            </li>
          ))}
        </ul>
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
                <a href={blobUrl(projectId, s.blobKey)} target="_blank" rel="noreferrer" className={link}>bytes {s.baseOffset.toLocaleString()}–{(s.baseOffset + s.length).toLocaleString()}</a>
                <span className="text-on-surface-variant">{formatBytes(s.length)} · {formatRelative(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </PageLoading>
  );
}
