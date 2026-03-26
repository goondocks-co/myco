import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, Sparkles, Check } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { useSession } from '../../hooks/use-sessions';
import { useSymbionts, buildResumeCommand } from '../../hooks/use-symbionts';
import { useTriggerRun } from '../../hooks/use-agent';
import { BatchTimeline } from './BatchTimeline';
import { StatusBadge } from './status-helpers';
import { formatTimeAgo, formatDuration as formatDurationSec } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Characters shown from session ID in compact view. */
const SESSION_ID_PREVIEW_LENGTH = 8;

/** Characters shown from content hash in metadata. */
const CONTENT_HASH_PREVIEW_LENGTH = 16;

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

/** Duration before the "Copied" indicator resets. */
const COPY_FEEDBACK_MS = 1500;

/** Structured key-value row for metadata. */
function MetaItem({ label, value, mono = true, copyable = false, code = false }: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  code?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }, [value]);

  const valueEl = code ? (
    <code className="text-xs font-mono text-primary bg-surface-container-lowest rounded px-1.5 py-0.5">{value}</code>
  ) : (
    <span className={cn('text-xs text-on-surface', mono && 'font-mono')}>{value}</span>
  );

  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-[var(--ghost-border)] last:border-0">
      <span className="shrink-0 w-20 font-sans text-xs font-medium text-on-surface-variant">{label}</span>
      {copyable ? (
        <button
          onClick={handleCopy}
          title="Click to copy"
          className="flex items-center gap-1.5 min-w-0 hover:text-primary transition-colors cursor-pointer"
        >
          {valueEl}
          {copied && <Check className="h-3 w-3 text-primary shrink-0" />}
        </button>
      ) : (
        <span className="min-w-0">{valueEl}</span>
      )}
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
  const { data: symbiontsData } = useSymbionts();
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

  const resumeCmd = symbiontsData
    ? buildResumeCommand(symbiontsData.symbionts, session.agent, id)
    : null;

  return (
    <div className="p-6 space-y-6 overflow-hidden">
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

      {/* Stats + Metadata cards (horizontal, above conversation) */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <StatCard label="Prompts" value={String(session.prompt_count)} accent="sage" />
        <StatCard label="Tool Calls" value={String(session.tool_count)} accent="sage" />
        <StatCard label="Status" value={session.status.charAt(0).toUpperCase() + session.status.slice(1)} accent="outline" />
        <StatCard label="Started" value={epochToAbsolute(session.started_at)} accent="outline" />
        <StatCard label="Ended" value={epochToAbsolute(session.ended_at)} accent="outline" />
        <StatCard
          label="Session ID"
          value={id.slice(0, SESSION_ID_PREVIEW_LENGTH)}
          sublabel={session.content_hash ? `hash: ${session.content_hash.slice(0, CONTENT_HASH_PREVIEW_LENGTH)}` : undefined}
          accent="outline"
        />
      </div>

      {/* Metadata details (collapsible-style row) */}
      <Surface level="low" className="p-4 overflow-hidden">
        <SectionHeader className="mb-3">Metadata</SectionHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
          <MetaItem label="Session ID" value={id} copyable />
          {resumeCmd && <MetaItem label="Resume" value={resumeCmd} copyable code />}
          {session.parent_session_id && (
            <MetaItem label="Parent" value={session.parent_session_id} />
          )}
          {session.parent_session_reason && (
            <MetaItem label="Reason" value={session.parent_session_reason} mono={false} />
          )}
          {session.project_root && (
            <MetaItem label="Project" value={session.project_root} />
          )}
        </div>
      </Surface>

      {/* Summary */}
      {session.summary && (
        <Surface level="low" className="p-4 overflow-hidden">
          <SectionHeader className="mb-2">Summary</SectionHeader>
          <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap break-words">{session.summary}</p>
        </Surface>
      )}

      {/* Conversation (full-width) */}
      <div className="min-w-0 overflow-hidden">
        <SectionHeader className="mb-3">Conversation</SectionHeader>
        <BatchTimeline sessionId={id} />
      </div>
    </div>
  );
}
