import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare, Trash2, Filter } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { PageHeader } from '../ui/page-header';
import { Input } from '../ui/input';
import { StatCard } from '../ui/stat-card';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useSessions, useDeleteSession, useSessionImpact, type SessionSummary } from '../../hooks/use-sessions';
import { StatusBadge } from './status-helpers';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Default limit for the sessions list. */
const DEFAULT_SESSIONS_LIMIT = 100;

/** Number of skeleton rows to show during loading. */
const SKELETON_ROW_COUNT = 5;

/** Characters shown from session ID in compact view. */
const SESSION_ID_PREVIEW_LENGTH = 8;

/** Characters shown from session ID in table column. */
const SESSION_ID_COLUMN_LENGTH = 12;

/* ---------- Sub-components ---------- */

function SessionTableRow({
  session,
  onClick,
  onDelete,
}: {
  session: SessionSummary;
  onClick: () => void;
  onDelete: () => void;
}) {
  const sessionLabel = session.title || session.id.slice(0, SESSION_ID_PREVIEW_LENGTH);

  return (
    <tr
      className="border-b border-[var(--ghost-border)] last:border-0 hover:bg-surface-container/60 cursor-pointer transition-all duration-150 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 hover:shadow-[inset_3px_0_0_var(--primary)]"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="row"
      aria-label={`Session: ${sessionLabel}`}
    >
      {/* Session ID */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {session.id.slice(0, SESSION_ID_COLUMN_LENGTH)}
        </span>
      </td>

      {/* Title */}
      <td className="px-4 py-3">
        <span className="font-sans text-sm font-medium text-on-surface truncate block max-w-xs">
          {sessionLabel}
        </span>
      </td>

      {/* Agent */}
      <td className="px-4 py-3">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {session.agent || 'unknown'}
        </Badge>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <StatusBadge status={session.status} />
      </td>

      {/* Turns */}
      <td className="px-4 py-3 text-center">
        <span className="font-mono text-xs text-on-surface-variant">
          {session.prompt_count}
        </span>
      </td>

      {/* Last Activity */}
      <td className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-on-surface-variant">
            {session.date}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
              }
            }}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-tertiary/10 hover:text-tertiary transition-all shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tertiary/40"
            aria-label={`Delete session ${sessionLabel}`}
            title="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function SkeletonTableRow() {
  return (
    <tr className="border-b border-[var(--ghost-border)]">
      <td className="px-4 py-3"><div className="h-3 w-20 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-40 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-8 rounded bg-surface-container-high animate-pulse mx-auto" /></td>
      <td className="px-4 py-3"><div className="h-3 w-20 rounded bg-surface-container-high animate-pulse" /></td>
    </tr>
  );
}

/** Column header with consistent styling. */
function ColHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-4 py-3 text-left font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant', className)}>
      {children}
    </th>
  );
}

/** Horizontal stat cards showing aggregate session data. */
function SessionStats({ sessions }: { sessions: SessionSummary[] }) {
  const stats = useMemo(() => {
    const activeSessions = sessions.filter((s) => s.status === 'active');
    const completedSessions = sessions.filter((s) => s.status === 'completed');
    const totalPrompts = sessions.reduce((sum, s) => sum + s.prompt_count, 0);
    const totalTools = sessions.reduce((sum, s) => sum + s.tool_count, 0);

    // Date range
    const dates = sessions.map((s) => s.started_at).filter(Boolean);
    const earliest = dates.length > 0 ? new Date(Math.min(...dates) * 1000).toISOString().slice(0, 10) : null;
    const latest = dates.length > 0 ? new Date(Math.max(...dates) * 1000).toISOString().slice(0, 10) : null;

    return {
      total: sessions.length,
      active: activeSessions.length,
      completed: completedSessions.length,
      totalPrompts,
      totalTools,
      earliest,
      latest,
    };
  }, [sessions]);

  const dateRange = stats.earliest && stats.latest
    ? `${stats.earliest} \u2014 ${stats.latest}`
    : undefined;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
      <StatCard
        label="Total Sessions"
        value={String(stats.total)}
        sublabel={dateRange}
        accent="sage"
      />
      <StatCard
        label="Active"
        value={String(stats.active)}
        accent="sage"
      />
      <StatCard
        label="Completed"
        value={String(stats.completed)}
        accent="outline"
      />
      <StatCard
        label="Prompts"
        value={String(stats.totalPrompts)}
        accent="outline"
      />
      <StatCard
        label="Tool Calls"
        value={String(stats.totalTools)}
        accent="outline"
      />
    </div>
  );
}

/* ---------- Component ---------- */

export function SessionList() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const { data, isLoading, isError, error } = useSessions({ limit: DEFAULT_SESSIONS_LIMIT });
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const deleteSession = useDeleteSession();
  const { data: impact } = useSessionImpact(deleteTarget?.id ?? null);

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    deleteSession.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const sessions = data?.sessions ?? [];
  const filtered = filter
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(filter.toLowerCase()) ||
          s.id.toLowerCase().includes(filter.toLowerCase()) ||
          (s.agent && s.agent.toLowerCase().includes(filter.toLowerCase())),
      )
    : sessions;

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Session Archive" subtitle="Loading..." />
        <Surface level="low" className="rounded-md overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
                <ColHeader>Session ID</ColHeader>
                <ColHeader>Title</ColHeader>
                <ColHeader>Agent</ColHeader>
                <ColHeader>Status</ColHeader>
                <ColHeader className="text-center">Turns</ColHeader>
                <ColHeader>Date</ColHeader>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <SkeletonTableRow key={i} />
              ))}
            </tbody>
          </table>
        </Surface>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <PageHeader title="Session Archive" />
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load sessions</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Session Archive"
        subtitle={`${sessions.length} session${sessions.length !== 1 ? 's' : ''} captured`}
      />

      {/* Stats cards */}
      {sessions.length > 0 && (
        <div className="mb-6">
          <SessionStats sessions={sessions} />
        </div>
      )}

      {/* Filter toolbar */}
      <Surface level="bright" className="flex items-center gap-3 px-4 py-2 mb-4 rounded-md">
        <Filter className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
        <Input
          placeholder="Filter sessions..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-auto py-0 font-sans text-sm"
          aria-label="Filter sessions by title, ID, or agent"
        />
        <span className="font-mono text-xs text-on-surface-variant shrink-0">
          {filtered.length}/{sessions.length}
        </span>
      </Surface>

      {filtered.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
          <MessageSquare className="h-8 w-8 opacity-30" />
          <span className="font-sans text-sm">
            {sessions.length === 0 ? 'No sessions yet' : 'No matching sessions'}
          </span>
          {sessions.length === 0 && (
            <span className="font-sans text-xs">Sessions appear here as you work with your agent</span>
          )}
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden">
          <table className="w-full" aria-label="Session archive">
            <thead>
              <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
                <ColHeader>Session ID</ColHeader>
                <ColHeader>Title</ColHeader>
                <ColHeader>Agent</ColHeader>
                <ColHeader>Status</ColHeader>
                <ColHeader className="text-center">Turns</ColHeader>
                <ColHeader>Date</ColHeader>
              </tr>
            </thead>
            <tbody>
              {filtered.map((session) => (
                <SessionTableRow
                  key={session.id}
                  session={session}
                  onClick={() => navigate(`/sessions/${session.id}`)}
                  onDelete={() => setDeleteTarget(session)}
                />
              ))}
            </tbody>
          </table>
        </Surface>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete Session"
        description="This will permanently remove this session and all related data. This action cannot be undone."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={deleteTarget ? [
          { label: 'ID', value: deleteTarget.id.slice(0, SESSION_ID_PREVIEW_LENGTH) },
          { label: 'Title', value: deleteTarget.title || deleteTarget.id.slice(0, SESSION_ID_PREVIEW_LENGTH) },
        ] : []}
        impact={impact ? [
          { label: 'Prompts', value: impact.promptCount },
          { label: 'Spores', value: impact.sporeCount },
          { label: 'Attachments', value: impact.attachmentCount },
          { label: 'Graph Edges', value: impact.graphEdgeCount },
        ] : []}
        confirmLabel="Delete Session"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        isPending={deleteSession.isPending}
      />
    </div>
  );
}
