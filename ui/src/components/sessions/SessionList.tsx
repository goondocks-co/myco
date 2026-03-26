import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare, Trash2, Search } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { PageHeader } from '../ui/page-header';
import { SessionPod, PodTimestamp, PodTitle } from '../ui/session-pod';
import { Input } from '../ui/input';
import { useSessions, useDeleteSession, type SessionSummary } from '../../hooks/use-sessions';

/* ---------- Constants ---------- */

/** Default limit for the sessions list. */
const DEFAULT_SESSIONS_LIMIT = 100;

/** Number of skeleton rows to show during loading. */
const SKELETON_ROW_COUNT = 5;

/** Characters shown from session ID in compact view. */
const SESSION_ID_PREVIEW_LENGTH = 8;

/* ---------- Helpers ---------- */

function statusVariant(status: string): 'default' | 'secondary' | 'warning' {
  if (status === 'active') return 'default';
  if (status === 'completed') return 'secondary';
  return 'warning';
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ---------- Sub-components ---------- */

function SessionRow({
  session,
  onClick,
  onDelete,
}: {
  session: SessionSummary;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <SessionPod onClick={onClick} className="group">
      <span className="font-mono text-xs text-on-surface-variant shrink-0 w-16">
        {session.id.slice(0, SESSION_ID_PREVIEW_LENGTH)}
      </span>
      <PodTitle className="flex-1 min-w-0">
        {session.title || session.id.slice(0, SESSION_ID_PREVIEW_LENGTH)}
      </PodTitle>
      <Badge variant={statusVariant(session.status)}>
        {statusLabel(session.status)}
      </Badge>
      <PodTimestamp>{session.date}</PodTimestamp>
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
    </SessionPod>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-container-low px-4 py-2.5 animate-pulse">
      <div className="h-3 w-16 rounded bg-surface-container-high" />
      <div className="h-3 flex-1 rounded bg-surface-container-high" />
      <div className="h-3 w-16 rounded bg-surface-container-high" />
      <div className="h-3 w-20 rounded bg-surface-container-high" />
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
          s.id.toLowerCase().includes(filter.toLowerCase()),
      )
    : sessions;

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Sessions" subtitle="Loading..." />
        <div className="space-y-0.5">
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <PageHeader title="Sessions" />
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
        title="Sessions"
        subtitle={`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
      />

      {/* Filter toolbar */}
      <Surface level="bright" className="flex items-center gap-3 px-4 py-2.5 mb-4">
        <Search className="h-4 w-4 text-on-surface-variant shrink-0" />
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
        <div className="space-y-0.5">
          {filtered.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onClick={() => navigate(`/sessions/${session.id}`)}
              onDelete={() => handleDelete(session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
