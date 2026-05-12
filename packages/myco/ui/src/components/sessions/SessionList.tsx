import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare, Trash2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { PageHeader } from '../ui/page-header';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useSessions, useDeleteSession, useSessionImpact, type SessionSummary } from '../../hooks/use-sessions';
import { useSymbionts } from '../../hooks/use-symbionts';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { shortSession } from '../../lib/format';
import { StatusBadge } from './status-helpers';
import { ReleaseStateDot } from '../release-state/ReleaseStateBadge';
import { cn } from '../../lib/cn';
import { useMemo, useState } from 'react';

/* ---------- Constants ---------- */

/** Number of skeleton rows to show during loading. */
const SKELETON_ROW_COUNT = 5;

/** Characters shown from session ID in table column. */
const SESSION_ID_COLUMN_LENGTH = 12;

const STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: FILTER_ALL, label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
  ],
};

/* ---------- Sub-components ---------- */

function SessionTableRow({
  session,
  symbiontDisplayName,
  onClick,
  onDelete,
}: {
  session: SessionSummary;
  symbiontDisplayName: string;
  onClick: () => void;
  onDelete: () => void;
}) {
  const sessionLabel = session.title || shortSession(session.id);

  return (
    <tr
      className="border-b border-[var(--ghost-border)] last:border-0 hover:bg-surface-container/60 cursor-pointer transition-all duration-150 group focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 hover:shadow-[inset_3px_0_0_var(--primary)]"
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

      {/* Symbiont */}
      <td className="px-4 py-3">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {symbiontDisplayName}
        </Badge>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <StatusBadge status={session.status} />
      </td>

      {/* Release */}
      <td className="px-4 py-3 text-center">
        <ReleaseStateDot annotation={session.release_state} className="mx-auto" />
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
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-tertiary/10 hover:text-tertiary transition-all shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-tertiary/40"
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
      <td className="px-4 py-3 text-center"><div className="h-2.5 w-2.5 rounded-full bg-surface-container-high animate-pulse mx-auto" /></td>
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

/* ---------- Component ---------- */

export function SessionList() {
  const navigate = useNavigate();
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } = useListFilters({
    initialFilters: { status: FILTER_ALL, agent: FILTER_ALL },
  });
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const deleteSession = useDeleteSession();
  const { data: impact } = useSessionImpact(deleteTarget?.id ?? null);
  const { data: symbiontsData } = useSymbionts();

  // Build the Symbiont filter from whichever symbionts this project has
  // enabled. The filter key stays `agent` because that's what the backend
  // sessions query expects, but the label and options reflect the project's
  // actual configuration rather than a hardcoded list.
  const sessionFilters = useMemo<FilterDefinition[]>(() => {
    const enabledSymbionts = (symbiontsData?.symbionts ?? []).filter((s) => s.enabled);
    const symbiontFilter: FilterDefinition = {
      key: 'agent',
      label: 'Symbiont',
      options: [
        { value: FILTER_ALL, label: 'All symbionts' },
        ...enabledSymbionts.map((s) => ({ value: s.name, label: s.displayName })),
      ],
    };
    return [STATUS_FILTER, symbiontFilter];
  }, [symbiontsData]);

  // Lookup from the DB-stored agent name (e.g. 'claude-code') to the
  // manifest display name. Falls back to the raw name for sessions whose
  // symbiont is no longer present — better than showing "unknown".
  const symbiontDisplayName = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const s of symbiontsData?.symbionts ?? []) {
      lookup.set(s.name, s.displayName);
    }
    return (agent: string | null | undefined): string => {
      if (!agent) return 'unknown';
      return lookup.get(agent) ?? agent;
    };
  }, [symbiontsData]);

  const activeStatus = activeFilter('status');
  const activeAgent = activeFilter('agent');

  const { data, isLoading, isError, error } = useSessions({
    limit: DEFAULT_PAGE_SIZE,
    offset,
    status: activeStatus,
    agent: activeAgent,
    search: debouncedSearch,
  });

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    deleteSession.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;

  const toolbar = (
    <ListToolbar
      searchPlaceholder="Search sessions..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={sessionFilters}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
    />
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
        <ColHeader>Session ID</ColHeader>
        <ColHeader>Title</ColHeader>
        <ColHeader>Symbiont</ColHeader>
        <ColHeader>Status</ColHeader>
        <ColHeader className="w-16 text-center">Release</ColHeader>
        <ColHeader className="text-center">Turns</ColHeader>
        <ColHeader>Date</ColHeader>
      </tr>
    </thead>
  );

  if (isError) {
    return (
      <div>
        <PageHeader title="Session Archive" />
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary mt-4">
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
        subtitle={isLoading ? 'Loading...' : `${total} session${total !== 1 ? 's' : ''} captured`}
      />

      {toolbar}

      {isLoading ? (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <table className="w-full">
            {tableHead}
            <tbody>
              {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <SkeletonTableRow key={i} />
              ))}
            </tbody>
          </table>
        </Surface>
      ) : sessions.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant mt-4">
          <MessageSquare className="h-8 w-8 opacity-30" />
          <span className="font-sans text-sm">
            {total === 0 && !debouncedSearch && !activeStatus && !activeAgent
              ? 'No sessions yet'
              : 'No matching sessions'}
          </span>
          {total === 0 && !debouncedSearch && !activeStatus && !activeAgent && (
            <span className="font-sans text-xs">Sessions appear here as you work with your agent</span>
          )}
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <table className="w-full" aria-label="Session archive">
            {tableHead}
            <tbody>
              {sessions.map((session) => (
                <SessionTableRow
                  key={session.id}
                  session={session}
                  symbiontDisplayName={symbiontDisplayName(session.agent)}
                  onClick={() => navigate(`/sessions/${session.id}`)}
                  onDelete={() => setDeleteTarget(session)}
                />
              ))}
            </tbody>
          </table>
        </Surface>
      )}

      <Pagination
        total={total}
        offset={offset}
        limit={DEFAULT_PAGE_SIZE}
        onPageChange={setOffset}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete Session"
        description="This will permanently remove this session and all related data. This action cannot be undone."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={deleteTarget ? [
          { label: 'ID', value: shortSession(deleteTarget.id) },
          { label: 'Title', value: deleteTarget.title || shortSession(deleteTarget.id) },
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
