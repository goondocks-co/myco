import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../ui/badge';
import { MarkdownContent } from '../ui/markdown-content';
import { PageLoading } from '../ui/page-loading';
import { Panel } from '../ui/panel';
import { StatCard } from '../ui/stat-card';
import { StatusDot } from '../ui/status-dot';
import { SubtabPill } from '../ui/subtab-pill';
import {
  blobUrl, memberName, RENDERABLE_IMAGE_TYPES, runtimeName, useBlobText, useSession, useSessionChildren, useTranscript,
  type AttachmentRow, type PlanRow, type PromptRow, type ResponseRow, type SessionRow, type ToolCallRow,
} from '../../hooks/use-sessions';
import { ApiError } from '../../lib/api';
import { formatBytes, formatCount, formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { NotFound } from '../../pages/NotFound';

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'plans', label: 'Plans' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'transcript', label: 'Transcript' },
];

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';
const link = 'font-sans text-xs text-primary underline';

export function SessionDetail({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const detail = useSession(projectId, sessionId);
  const [tab, setTab] = useState('conversation');
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
  return (
    <PageLoading isLoading={detail.isPending} error={detail.error}>
      {detail.data && (
        <div className="flex flex-col gap-4">
          <Facts projectId={projectId} session={detail.data.session} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Prompts" value={detail.data.counts.prompts.toLocaleString()} accent="sage" />
            <StatCard label="Tool calls" value={detail.data.counts.toolCalls.toLocaleString()} accent="ochre" />
            <StatCard label="Responses" value={detail.data.counts.responses.toLocaleString()} accent="sage" />
            <StatCard label="Plans" value={detail.data.counts.plans.toLocaleString()} accent="outline" />
            <StatCard label="Attachments" value={detail.data.counts.attachments.toLocaleString()} accent="outline" />
          </div>
          <SubtabPill tabs={TABS} activeTab={tab} onTabChange={setTab} />
          {tab === 'conversation' && <Conversation projectId={projectId} sessionId={sessionId} />}
          {tab === 'plans' && <Plans projectId={projectId} sessionId={sessionId} />}
          {tab === 'attachments' && <Attachments projectId={projectId} sessionId={sessionId} />}
          {tab === 'transcript' && <Transcript projectId={projectId} sessionId={sessionId} />}
        </div>
      )}
    </PageLoading>
  );
}

function Facts({ projectId, session }: { projectId: string; session: SessionRow }) {
  const open = session.endedAt === null;
  return (
    <div>
      <div className="flex items-center gap-2">
        <StatusDot tone={open ? 'sage' : 'outline'} />
        <div className="font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Session · {open ? 'open' : 'ended'}</div>
      </div>
      <h2 className="font-serif text-xl text-on-surface">{session.agent ?? 'Session'}{session.branch ? <span className="font-mono text-base text-on-surface-variant"> on {session.branch}</span> : null}</h2>
      <div className="font-mono text-[11px] text-on-surface-variant">{session.sessionId}</div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 font-sans text-sm sm:grid-cols-2">
        <Fact label="Started" value={session.startedAt === null ? null : `${formatRelative(session.startedAt)} · ${formatDateTime(session.startedAt)}`} />
        <Fact label={open ? 'Last received' : 'Ended'} value={open ? formatRelative(session.lastReceivedAt) : `${formatRelative(session.endedAt)} · ${formatDuration(session.startedAt, session.endedAt)}`} />
        <Fact label="Member" value={memberName(session)} />
        <Fact label="Runtime" value={[runtimeName(session), session.machineId].filter((v) => v !== null).join(' · ') || null} />
        <Fact label="Path" value={session.originPath} />
        <Fact label="Parent" value={session.parentSessionId === null ? null : (
          <Link to={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.parentSessionId)}`} className={link}>
            {session.parentSessionId}{session.parentReason ? ` (${session.parentReason})` : ''}
          </Link>
        )} />
      </dl>
    </div>
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

/** Stored text that spilled to a blob, fetched and shown; a line says so while it loads, so a bubble is never blank. */
function BlobText({ projectId, blobKey }: { projectId: string; blobKey: string }) {
  const text = useBlobText(projectId, blobKey);
  if (text.isPending) return <span className="font-sans text-xs text-on-surface-variant">Loading stored text…</span>;
  if (text.error) return <span className="font-sans text-xs text-tertiary">The stored text could not be read.</span>;
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm text-on-surface">{text.data}</pre>;
}

function TextOrBlob({ projectId, text, blobKey }: { projectId: string; text: string | null; blobKey: string | null }) {
  if (text !== null) return <pre className="whitespace-pre-wrap break-words font-sans text-sm text-on-surface">{text}</pre>;
  if (blobKey !== null) return <BlobText projectId={projectId} blobKey={blobKey} />;
  return <span className="font-sans text-xs text-on-surface-variant">No text recorded.</span>;
}

type TimelineItem =
  | { kind: 'prompt'; at: number; id: string; row: PromptRow }
  | { kind: 'tool'; at: number; id: string; row: ToolCallRow }
  | { kind: 'response'; at: number; id: string; row: ResponseRow };

/** On the same millisecond a prompt comes before its tool calls, and those before the response. */
const KIND_RANK: Record<TimelineItem['kind'], number> = { prompt: 0, tool: 1, response: 2 };

/** Prompts, tool calls and responses, each its own paged read, shown as one timeline; a page of one child can outrun another, so "Load more" is per child. */
function Conversation({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const prompts = useSessionChildren<PromptRow>(projectId, sessionId, 'prompts');
  const tools = useSessionChildren<ToolCallRow>(projectId, sessionId, 'tool-calls');
  const responses = useSessionChildren<ResponseRow>(projectId, sessionId, 'responses');
  const items: TimelineItem[] = [
    ...prompts.rows.map((row) => ({ kind: 'prompt' as const, at: row.orderedAt, id: `p:${row.promptId}`, row })),
    ...tools.rows.map((row) => ({ kind: 'tool' as const, at: row.orderedAt, id: `t:${row.toolCallId}`, row })),
    ...responses.rows.map((row) => ({ kind: 'response' as const, at: row.orderedAt, id: `r:${row.responseId}`, row })),
  ].sort((a, b) => a.at - b.at || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
  const more = [prompts, tools, responses].filter((c) => c.hasMore);
  return (
    <PageLoading isLoading={prompts.isPending || tools.isPending || responses.isPending} error={prompts.error ?? tools.error ?? responses.error}>
      {items.length === 0 ? (
        <p className="font-sans text-sm text-on-surface-variant">Nothing captured in this session yet.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Conversation">
          {items.map((item) => (
            <li key={item.id} data-testid={`bubble-${item.kind}`}>
              {item.kind === 'prompt' && (
                <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
                  <div className="mb-1 flex items-center gap-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">
                    <span>Prompt</span>
                    {item.row.origin !== 'user' && <Badge variant="outline">{item.row.origin}</Badge>}
                    {item.row.threadLabel !== null && <span>{item.row.threadLabel}</span>}
                    <span className="ml-auto normal-case tracking-normal">{formatRelative(item.row.createdAt)}</span>
                  </div>
                  <TextOrBlob projectId={projectId} text={item.row.text} blobKey={item.row.blobKey} />
                </div>
              )}
              {item.kind === 'tool' && <ToolCall projectId={projectId} row={item.row} />}
              {item.kind === 'response' && (
                <div className="rounded-lg border border-outline-variant/20 p-3">
                  <div className="mb-1 flex items-center gap-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">
                    <span>Response</span>
                    <span className="ml-auto normal-case tracking-normal">{formatRelative(item.row.createdAt)}</span>
                  </div>
                  <TextOrBlob projectId={projectId} text={item.row.text} blobKey={item.row.blobKey} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {more.length > 0 && (
        <div className="mt-3">
          <button type="button" className={button} onClick={() => { for (const c of more) c.more(); }}>Load more</button>
        </div>
      )}
    </PageLoading>
  );
}

function ToolCall({ projectId, row }: { projectId: string; row: ToolCallRow }) {
  return (
    <div className="ml-4 rounded-md border border-outline-variant/10 px-3 py-2 font-sans text-sm">
      <div className="flex items-center gap-2">
        <StatusDot tone={row.success ? 'sage' : 'terracotta'} sizePx={5} />
        <span className="font-mono text-xs text-on-surface">{row.toolName}{row.mycoTool ? ` · ${row.mycoTool}${row.mycoOp ? `:${row.mycoOp}` : ''}` : ''}</span>
        {row.durationMs !== null && <span className="font-mono text-[11px] text-on-surface-variant">{row.durationMs}ms</span>}
        <span className="ml-auto font-mono text-[11px] text-on-surface-variant">{formatRelative(row.createdAt)}</span>
      </div>
      {row.errorMessage !== null && <p className="mt-1 text-xs text-tertiary">{row.errorMessage}</p>}
      {row.outputPreview !== null && <p className="mt-1 truncate text-xs text-on-surface-variant">{row.outputPreview}</p>}
      {(row.inputPreview !== null || row.inputBlobKey !== null) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-on-surface-variant">Input{row.inputBytes !== null ? ` · ${formatBytes(row.inputBytes)}` : ''}</summary>
          {row.inputPreview !== null && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-on-surface-variant">{row.inputPreview}{row.inputBytes !== null && row.inputBytes > row.inputPreview.length ? '…' : ''}</pre>}
          {row.inputBlobKey !== null && <a href={blobUrl(projectId, row.inputBlobKey)} target="_blank" rel="noreferrer" className={link}>Full input</a>}
        </details>
      )}
      {row.outputBlobKey !== null && <a href={blobUrl(projectId, row.outputBlobKey)} target="_blank" rel="noreferrer" className={link}>Full output</a>}
    </div>
  );
}

function Plans({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const plans = useSessionChildren<PlanRow>(projectId, sessionId, 'plans');
  return (
    <PageLoading isLoading={plans.isPending} error={plans.error}>
      {plans.rows.length === 0 ? (
        <p className="font-sans text-sm text-on-surface-variant">No plans captured in this session.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.rows.map((plan) => (
            <Panel key={plan.planKey} title={plan.title ?? plan.planKey} actions={<Badge variant={plan.status === 'completed' ? 'default' : 'secondary'}>{plan.status}</Badge>}>
              <div className="mb-2 font-sans text-xs text-on-surface-variant">updated {formatRelative(plan.updatedAt)}</div>
              {plan.content !== null ? <MarkdownContent content={plan.content} /> : plan.blobKey !== null ? <BlobText projectId={projectId} blobKey={plan.blobKey} /> : <p className="font-sans text-sm text-on-surface-variant">No content recorded.</p>}
            </Panel>
          ))}
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
