import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useSession } from '../../hooks/use-sessions';
import { useTriggerRun } from '../../hooks/use-agent';
import { BatchTimeline } from './BatchTimeline';
import { formatTimeAgo } from '../../lib/format';

/* ---------- Helpers ---------- */

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'completed') return 'secondary';
  return 'outline';
}

function epochToRelative(epoch: number | null): string {
  if (epoch === null) return '—';
  return formatTimeAgo(new Date(epoch * 1000).toISOString());
}

function epochToAbsolute(epoch: number | null): string {
  if (epoch === null) return '—';
  return new Date(epoch * 1000).toLocaleString();
}

// Duration formatting imported from shared library
import { formatDuration as formatDurationSec } from '../../lib/format';

/* ---------- Sub-components ---------- */

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground font-mono text-right break-all">{value}</span>
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
        <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} className="gap-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Sessions
        </Button>
        <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading session...</span>
        </div>
      </div>
    );
  }

  if (isError || !session) {
    return (
      <div className="p-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} className="gap-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Sessions
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">Session not found</span>
          <span className="text-xs text-muted-foreground">
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
        className="gap-2 text-muted-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Sessions
      </Button>

      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{session.title ?? session.id.slice(0, 8)}</h1>
          <Badge variant={statusVariant(session.status)}>
            {session.status.charAt(0).toUpperCase() + session.status.slice(1)}
          </Badge>
          <Button
            variant="outline"
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
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {session.agent && <span>Agent: <span className="text-foreground">{session.agent}</span></span>}
          {session.user && <span>User: <span className="text-foreground">{session.user}</span></span>}
          {session.branch && <span>Branch: <span className="text-foreground font-mono">{session.branch}</span></span>}
          <span>Started {epochToRelative(session.started_at)}</span>
          {session.ended_at && (
            <span>Duration: {formatDurationSec(session.started_at, session.ended_at)}</span>
          )}
        </div>
      </div>

      {/* Summary */}
      {session.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{session.summary}</p>
          </CardContent>
        </Card>
      )}

      {/* Main layout: timeline + metadata sidebar */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Batch timeline */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Conversation
          </h2>
          <BatchTimeline sessionId={id} />
        </div>

        {/* Metadata sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Stats</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <MetaRow label="Prompts" value={String(session.prompt_count)} />
              <MetaRow label="Tool calls" value={String(session.tool_count)} />
              <MetaRow label="Status" value={session.status} />
              <MetaRow label="Started" value={epochToAbsolute(session.started_at)} />
              <MetaRow label="Ended" value={epochToAbsolute(session.ended_at)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <MetaRow label="Session ID" value={id} />
              {session.parent_session_id && (
                <MetaRow label="Parent" value={session.parent_session_id} />
              )}
              {session.parent_session_reason && (
                <MetaRow label="Reason" value={session.parent_session_reason} />
              )}
              {session.content_hash && (
                <MetaRow label="Hash" value={session.content_hash.slice(0, 16) + '…'} />
              )}
              {session.transcript_path && (
                <MetaRow label="Transcript" value={session.transcript_path} />
              )}
              {session.project_root && (
                <MetaRow label="Project" value={session.project_root} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
