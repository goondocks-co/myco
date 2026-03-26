import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare, Trash2, Filter } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { PageHeader } from '../ui/page-header';
import { Input } from '../ui/input';
import { useSessions, useDeleteSession, type SessionSummary } from '../../hooks/use-sessions';
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

function StatusDot({ status }: { status: string }) {
  const color = resolveStatusColor(status);
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', STATUS_DOT_CLASSES[color])} />
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = resolveStatusColor(status);
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans text-xs font-medium', STATUS_BADGE_CLASSES[color])}>
      <StatusDot status={status} />
      {label}
    </span>
  );
}

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
  return (
    <tr
      className="border-b border-[var(--ghost-border)] last:border-0 hover:bg-surface-container-low/60 cursor-pointer transition-colors group"
      onClick={onClick}
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
          {session.title || session.id.slice(0, SESSION_ID_PREVIEW_LENGTH)}
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
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-tertiary/10 hover:text-tertiary transition-all shrink-0"
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

/** Stats sidebar showing aggregate session data. */
function SessionStats({ sessions }: { sessions: SessionSummary[] }) {
  const stats = useMemo(() => {
    const activeSessions = sessions.filter((s) => s.status === 'active');
    const completedSessions = sessions.filter((s) => s.status === 'completed');
    const errorSessions = sessions.filter((s) => s.status === 'error');
    const totalPrompts = sessions.reduce((sum, s) => sum + s.prompt_count, 0);
    const totalTools = sessions.reduce((sum, s) => sum + s.tool_count, 0);

    // Agent breakdown
    const agentCounts: Record<string, number> = {};
    for (const s of sessions) {
      const agent = s.agent || 'unknown';
      agentCounts[agent] = (agentCounts[agent] || 0) + 1;
    }

    // Date range
    const dates = sessions.map((s) => s.started_at).filter(Boolean);
    const earliest = dates.length > 0 ? new Date(Math.min(...dates) * 1000).toISOString().slice(0, 10) : null;
    const latest = dates.length > 0 ? new Date(Math.max(...dates) * 1000).toISOString().slice(0, 10) : null;

    return {
      total: sessions.length,
      active: activeSessions.length,
      completed: completedSessions.length,
      errors: errorSessions.length,
      totalPrompts,
      totalTools,
      agentCounts,
      earliest,
      latest,
    };
  }, [sessions]);

  return (
    <div className="space-y-4">
      <Surface level="low" className="p-4">
        <h3 className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-3">
          Session Stats
        </h3>

        <div className="space-y-3">
          {/* Total sessions */}
          <div>
            <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-1">
              Total Sessions
            </div>
            <div className="font-mono text-2xl text-on-surface font-light">
              {stats.total}
            </div>
          </div>

          {/* Status breakdown */}
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <StatusDot status="active" />
                <span className="font-sans text-[10px] text-on-surface-variant">Active</span>
              </div>
              <span className="font-mono text-sm text-on-surface">{stats.active}</span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <StatusDot status="completed" />
                <span className="font-sans text-[10px] text-on-surface-variant">Complete</span>
              </div>
              <span className="font-mono text-sm text-on-surface">{stats.completed}</span>
            </div>
            {stats.errors > 0 && (
              <div className="flex-1">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <StatusDot status="error" />
                  <span className="font-sans text-[10px] text-on-surface-variant">Error</span>
                </div>
                <span className="font-mono text-sm text-on-surface">{stats.errors}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-[var(--ghost-border)]" />

          {/* Prompts / Tool calls */}
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="font-sans text-[10px] text-on-surface-variant mb-0.5">Prompts</div>
              <span className="font-mono text-sm text-on-surface">{stats.totalPrompts}</span>
            </div>
            <div className="flex-1">
              <div className="font-sans text-[10px] text-on-surface-variant mb-0.5">Tool Calls</div>
              <span className="font-mono text-sm text-on-surface">{stats.totalTools}</span>
            </div>
          </div>

          {/* Date range */}
          {stats.earliest && stats.latest && (
            <>
              <div className="border-t border-[var(--ghost-border)]" />
              <div>
                <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-1">
                  Date Range
                </div>
                <div className="font-mono text-xs text-on-surface">
                  {stats.earliest}
                </div>
                <div className="font-mono text-xs text-on-surface-variant">
                  to {stats.latest}
                </div>
              </div>
            </>
          )}

          {/* Agent breakdown */}
          {Object.keys(stats.agentCounts).length > 0 && (
            <>
              <div className="border-t border-[var(--ghost-border)]" />
              <div>
                <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-2">
                  Agents
                </div>
                <div className="space-y-1.5">
                  {Object.entries(stats.agentCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([agent, count]) => (
                      <div key={agent} className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
                          {agent}
                        </Badge>
                        <span className="font-mono text-xs text-on-surface-variant">{count}</span>
                      </div>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Surface>
    </div>
  );
}

/* ---------- Component ---------- */

export function SessionList() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const { data, isLoading, isError, error } = useSessions({ limit: DEFAULT_SESSIONS_LIMIT });
  const deleteSession = useDeleteSession();

  function handleDelete(session: SessionSummary) {
    const label = session.title || session.id.slice(0, SESSION_ID_PREVIEW_LENGTH);
    if (!window.confirm(`Delete session "${label}"?\n\nThis will permanently remove all batches, activities, and attachments for this session.`)) {
      return;
    }
    deleteSession.mutate(session.id);
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        {/* Main table column */}
        <div className="min-w-0">
          {/* Filter toolbar */}
          <Surface level="bright" className="flex items-center gap-3 px-4 py-2 mb-4 rounded-md">
            <Filter className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
            <Input
              placeholder="Filter sessions..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-auto py-0 font-sans text-sm"
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
                  {filtered.map((session) => (
                    <SessionTableRow
                      key={session.id}
                      session={session}
                      onClick={() => navigate(`/sessions/${session.id}`)}
                      onDelete={() => handleDelete(session)}
                    />
                  ))}
                </tbody>
              </table>
            </Surface>
          )}
        </div>

        {/* Stats sidebar */}
        {sessions.length > 0 && (
          <div className="hidden lg:block">
            <SessionStats sessions={sessions} />
          </div>
        )}
      </div>
    </div>
  );
}
