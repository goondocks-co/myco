import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, Sparkles, Check, Trash2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useSession, useDeleteSession, useSessionImpact, useSessionPlans } from '../../hooks/use-sessions';
import { useSymbionts, buildResumeCommand } from '../../hooks/use-symbionts';
import { useTriggerRun } from '../../hooks/use-agent';
import { BatchTimeline } from './BatchTimeline';
import { SessionPlans } from './SessionPlans';
import { StatusBadge } from './status-helpers';
import { formatTimeAgo, formatDuration as formatDurationSec } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Characters shown from session ID in compact view. */
const SESSION_ID_PREVIEW_LENGTH = 8;

/* ---------- Helpers ---------- */

function epochToRelative(epoch: number | null): string {
  if (epoch === null) return '\u2014';
  return formatTimeAgo(new Date(epoch * 1000).toISOString());
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

type TabValue = 'conversation' | 'plans';

function TabButton({ label, value, activeTab, onClick }: {
  label: string;
  value: TabValue;
  activeTab: TabValue;
  onClick: (v: TabValue) => void;
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={cn(
        'px-4 py-2 font-sans text-sm font-medium transition-colors cursor-pointer',
        activeTab === value
          ? 'border-b-2 border-primary text-on-surface'
          : 'text-muted-foreground hover:text-on-surface',
      )}
    >
      {label}
    </button>
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabValue>('conversation');
  const deleteSession = useDeleteSession();
  const { data: impact } = useSessionImpact(deleteOpen ? id : null);
  const { data: plans } = useSessionPlans(id);

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
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-tertiary hover:text-tertiary hover:bg-tertiary/10"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
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

      {/* Key stats (compact row) */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Prompts" value={String(session.prompt_count)} accent="sage" />
        <StatCard label="Tool Calls" value={String(session.tool_count)} accent="sage" />
        <StatCard label="Plans" value={String(plans?.length ?? 0)} accent="outline" />
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

      {/* Tab navigation */}
      <div className="min-w-0 overflow-hidden">
        <div className="flex gap-0 border-b border-border mb-4">
          <TabButton label="Conversation" value="conversation" activeTab={activeTab} onClick={setActiveTab} />
          <TabButton label="Plans" value="plans" activeTab={activeTab} onClick={setActiveTab} />
        </div>

        {activeTab === 'conversation' && <BatchTimeline sessionId={id} />}
        {activeTab === 'plans' && <SessionPlans sessionId={id} />}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Session"
        description="This will permanently remove this session and all related data. This action cannot be undone."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={session ? [
          { label: 'ID', value: session.id.slice(0, SESSION_ID_PREVIEW_LENGTH) },
          { label: 'Title', value: session.title || session.id.slice(0, SESSION_ID_PREVIEW_LENGTH) },
        ] : []}
        impact={impact ? [
          { label: 'Prompts', value: impact.promptCount },
          { label: 'Spores', value: impact.sporeCount },
          { label: 'Attachments', value: impact.attachmentCount },
          { label: 'Graph Edges', value: impact.graphEdgeCount },
        ] : []}
        confirmLabel="Delete Session"
        variant="destructive"
        onConfirm={() => {
          deleteSession.mutate(session!.id, {
            onSuccess: () => {
              setDeleteOpen(false);
              navigate('/sessions');
            },
          });
        }}
        isPending={deleteSession.isPending}
      />
    </div>
  );
}
