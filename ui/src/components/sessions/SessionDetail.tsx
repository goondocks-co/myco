import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { useSession } from '../../hooks/use-sessions';
import { useTriggerRun } from '../../hooks/use-agent';
import { BatchTimeline } from './BatchTimeline';
import { formatTimeAgo, formatDuration as formatDurationSec } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Characters shown from session ID in compact view. */
const SESSION_ID_PREVIEW_LENGTH = 8;

/** Characters shown from content hash in metadata. */
const CONTENT_HASH_PREVIEW_LENGTH = 16;

/* ---------- Status helpers ---------- */

type StatusColor = 'active' | 'completed' | 'error';

function resolveStatusColor(status: string): StatusColor {
  if (status === 'active') return 'active';
  if (status === 'completed') return 'completed';
  return 'error';
}

const STATUS_DOT_CLASSES: Record<StatusColor, string> = {
  active: 'bg-primary',
  completed: 'bg-secondary',
  error: 'bg-tertiary',
};

const STATUS_BADGE_CLASSES: Record<StatusColor, string> = {
  active: 'bg-primary/15 text-primary',
  completed: 'bg-surface-container-high text-on-surface-variant',
  error: 'bg-tertiary/15 text-tertiary',
};

function StatusBadge({ status }: { status: string }) {
  const color = resolveStatusColor(status);
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans text-xs font-medium', STATUS_BADGE_CLASSES[color])}>
      <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', STATUS_DOT_CLASSES[color])} />
      {label}
    </span>
  );
}

/* ---------- Helpers ---------- */

function epochToRelative(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return formatTimeAgo(new Date(epoch * 1000).toISOString());
}

function epochToAbsolute(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return new Date(epoch * 1000).toLocaleString();
}

/* ---------- Sub-components ---------- */

/** Section header with the uppercase label treatment. */
function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn('font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant', className)}>
      {children}
    </h2>
  );
}

/** Structured key-value row for metadata. */
function MetaItem({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-[var(--ghost-border)] last:border-0">
      <span className="shrink-0 font-sans text-xs font-medium text-on-surface-variant">{label}</span>
      <span className={cn('text-xs text-on-surface text-right break-all', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

/* ---------- Component ---------- */

export interface SessionDetailProps {
  id: string;
}

export function SessionDetail({ id }: SessionDetailProps) {
  const navigate = useNavigate();
  const { data: session, isLoading, isError, error } = useSession(id);
  const triggerRun = useTriggerRun();
  const [summaryStatus, setSummaryStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          <span className="font-sans text-sm">Session Archive</span>
        </Button>
        <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="font-sans text-sm">Loading session...</span>
        </div>
      </div>
    );
  }

  if (isError || !session) {
    return (
      <div className="p-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          <span className="font-sans text-sm">Session Archive</span>
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Session not found</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Back nav */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/sessions')}
        className="gap-2 text-on-surface-variant"
      >
        <ArrowLeft className="h-4 w-4" />
        <span className="font-sans text-sm">Session Archive</span>
      </Button>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-serif text-2xl font-normal text-on-surface tracking-wide">
            {session.title ?? session.id.slice(0, SESSION_ID_PREVIEW_LENGTH)}
          </h1>
          <StatusBadge status={session.status} />
          {session.agent && (
            <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
              {session.agent}
            </Badge>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto gap-2"
            disabled={summaryStatus === 'running'}
            onClick={async () => {
              setSummaryStatus('running');
              try {
                await triggerRun.mutateAsync({
                  task: 'title-summary',
                  instruction: `Process session ${id} only`,
                });
                setSummaryStatus('done');
              } catch {
                setSummaryStatus('error');
              }
            }}
          >
            {summaryStatus === 'running' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {summaryStatus === 'done' ? 'Summary Requested' : 'Generate Summary'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 font-sans text-sm text-on-surface-variant">
          {session.user && (
            <span>User: <span className="text-on-surface">{session.user}</span></span>
          )}
          {session.branch && (
            <span>Branch: <span className="font-mono text-on-surface">{session.branch}</span></span>
          )}
          <span>Started {epochToRelative(session.started_at)}</span>
          {session.ended_at && (
            <span>Duration: {formatDurationSec(session.started_at, session.ended_at)}</span>
          )}
        </div>
      </div>

      {/* Summary */}
      {session.summary && (
        <Surface level="low" className="p-4">
          <SectionLabel className="mb-2">Summary</SectionLabel>
          <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap">{session.summary}</p>
        </Surface>
      )}

      {/* Two-column layout: conversation + metadata sidebar */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(280px,35%)]">
        {/* Conversation column */}
        <div>
          <SectionLabel className="mb-3">Conversation</SectionLabel>
          <BatchTimeline sessionId={id} />
        </div>

        {/* Metadata sidebar */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Surface level="low" className="p-4">
            <SectionLabel className="mb-3">Stats</SectionLabel>
            <MetaItem label="Prompts" value={String(session.prompt_count)} />
            <MetaItem label="Tool calls" value={String(session.tool_count)} />
            <MetaItem label="Status" value={session.status} />
            <MetaItem label="Started" value={epochToAbsolute(session.started_at)} />
            <MetaItem label="Ended" value={epochToAbsolute(session.ended_at)} />
          </Surface>

          <Surface level="low" className="p-4">
            <SectionLabel className="mb-3">Metadata</SectionLabel>
            <MetaItem label="Session ID" value={id} />
            {session.parent_session_id && (
              <MetaItem label="Parent" value={session.parent_session_id} />
            )}
            {session.parent_session_reason && (
              <MetaItem label="Reason" value={session.parent_session_reason} mono={false} />
            )}
            {session.content_hash && (
              <MetaItem label="Hash" value={session.content_hash.slice(0, CONTENT_HASH_PREVIEW_LENGTH) + '\u2026'} />
            )}
            {session.transcript_path && (
              <MetaItem label="Transcript" value={session.transcript_path} />
            )}
            {session.project_root && (
              <MetaItem label="Project" value={session.project_root} />
            )}
          </Surface>
        </div>
      </div>
    </div>
  );
}
