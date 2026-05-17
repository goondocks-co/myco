import { useNavigate } from 'react-router-dom';
import { AlertCircle, GitBranch, MessageSquare, Trash2 } from 'lucide-react';
import { Surface } from '../ui/surface';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { Sparkline } from '../ui/sparkline';
import { useSessions, useDeleteSession, useSessionImpact, type SessionSummary } from '../../hooks/use-sessions';
import { useSymbionts } from '../../hooks/use-symbionts';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { shortSession, formatEpochAgo } from '../../lib/format';
import { ReleaseStateDot } from '../release-state/ReleaseStateBadge';
import { sectionRows } from '../../lib/section-rows';
import { cn } from '../../lib/cn';
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useListKeyboardNav } from '../../hooks/use-list-keyboard-nav';

/* ---------- Constants ---------- */

/** Number of skeleton rows to show during loading. */
const SKELETON_ROW_COUNT = 5;

const STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: FILTER_ALL, label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
  ],
};

/* ---------- Helpers ---------- */

function statusTone(status: string): StatusTone {
  if (status === 'active') return 'sage';
  if (status === 'completed') return 'outline';
  return 'ochre';
}

/* ---------- Sub-components ---------- */

const SessionCardRow = forwardRef<HTMLDivElement, {
  session: SessionSummary;
  symbiontDisplayName: string;
  isSelected: boolean;
  isCursor: boolean;
  onClick: () => void;
  onDelete: () => void;
}>(function SessionCardRow({
  session,
  symbiontDisplayName,
  isSelected,
  isCursor,
  onClick,
  onDelete,
}, ref) {
  const sessionLabel = session.title || shortSession(session.id);

  return (
    <div
      ref={ref}
      data-selected={isSelected || undefined}
      data-cursor={isCursor || undefined}
      className={cn(
        'group relative border-b border-outline-variant/20 last:border-0 px-4 py-3 cursor-pointer transition-all duration-150',
        'hover:bg-surface-container-high/50 hover:shadow-[inset_3px_0_0_var(--primary)]',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        isSelected && 'bg-surface-container-high shadow-[inset_3px_0_0_var(--primary)]',
        isCursor && !isSelected && 'bg-surface-container/40 ring-2 ring-inset ring-primary/30',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="row"
      aria-selected={isSelected}
      aria-label={`Session: ${sessionLabel}`}
    >
      {/* Top row: status + title on the left, time + sparkline + actions on the right */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <StatusDot
            tone={statusTone(session.status)}
            pulse={session.status === 'active'}
            className="mt-1.5 shrink-0"
          />
          <h3 className="font-serif italic text-sm text-on-surface truncate leading-snug">
            {sessionLabel}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ReleaseStateDot annotation={session.release_state} />
          <span className="font-mono text-[10px] text-on-surface-variant whitespace-nowrap">
            {formatEpochAgo(session.started_at)}
          </span>
          <Sparkline data={session.activity_buckets} widthPx={48} heightPx={14} />
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
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-tertiary/10 hover:text-tertiary transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-tertiary/40"
            aria-label={`Delete session ${sessionLabel}`}
            title="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Meta line: agent · symbiont · prompts · tools */}
      <div className="mt-1.5 ml-5 font-mono text-[11px] text-on-surface-variant truncate">
        {session.agent} · {symbiontDisplayName} · {session.prompt_count}p · {session.tool_count}t
      </div>

      {/* Branch line: rendered only when a branch was captured */}
      {session.branch && (
        <div className="mt-0.5 ml-5 inline-flex items-center gap-1 font-mono text-[10px] italic text-on-surface-variant">
          <GitBranch className="h-2.5 w-2.5" />
          {session.branch}
        </div>
      )}
    </div>
  );
});

function SkeletonCardRow() {
  return (
    <div className="border-b border-outline-variant/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-surface-container-high animate-pulse shrink-0" />
          <div className="h-3 w-48 rounded bg-surface-container-high animate-pulse" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-3 w-10 rounded bg-surface-container-high animate-pulse" />
          <div className="h-3 w-12 rounded bg-surface-container-high animate-pulse" />
        </div>
      </div>
      <div className="mt-1.5 ml-5 h-2.5 w-40 rounded bg-surface-container-high animate-pulse" />
    </div>
  );
}

/* ---------- Component ---------- */

export interface SessionListProps {
  /** When set, the row with this session id renders as active. Also seeds the
   * keyboard-nav cursor so j/k continues from the selection. */
  selectedId?: string;
}

export function SessionList({ selectedId }: SessionListProps = {}) {
  const navigate = useNavigate();
  const filterInputRef = useRef<HTMLInputElement>(null);
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

  // Master-detail default: when the user lands on `/sessions` with no row
  // selected, jump to the topmost entry so the detail pane is never blank.
  // `replace: true` keeps `/sessions` out of history so back-navigation
  // skips the redirect.
  useEffect(() => {
    if (!selectedId && !isLoading && sessions.length > 0) {
      navigate(`/sessions/${sessions[0].id}`, { replace: true });
    }
  }, [selectedId, isLoading, sessions, navigate]);

  const nav = useListKeyboardNav({
    items: sessions,
    getId: (s) => s.id,
    selectedId,
    onActivate: (id) => navigate(`/sessions/${id}`),
    filterInputRef,
  });

  const toolbar = (
    <ListToolbar
      searchPlaceholder="Search sessions..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={sessionFilters}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
      inputRef={filterInputRef}
    />
  );

  // Page-local sums: aggregates reflect the visible page only. The sessions
  // query doesn't expose project-scoped totals for prompts/active-status
  // separately, so we sum what's loaded. TOTAL comes from the paginated
  // query response (server-wide for the current filter).
  const activeCount = sessions.filter((s) => s.status === 'active').length;
  const promptsTotal = sessions.reduce((sum, s) => sum + (s.prompt_count ?? 0), 0);

  const totalsHeader = (
    <div className="px-4 py-3 border-b border-outline-variant/20">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Sessions
        </h2>
        <span className="font-serif italic text-sm text-on-surface">Archive</span>
      </div>
      <div className="font-mono text-[11px] text-on-surface-variant inline-flex items-center gap-1.5">
        <span><strong className="text-on-surface font-semibold">{total.toLocaleString()}</strong> TOTAL</span>
        <span aria-hidden>·</span>
        <span><strong className="text-on-surface font-semibold">{activeCount.toLocaleString()}</strong> ACTIVE</span>
        <span aria-hidden>·</span>
        <span><strong className="text-on-surface font-semibold">{promptsTotal.toLocaleString()}</strong> PROMPTS</span>
      </div>
    </div>
  );

  if (isError) {
    return (
      <div className="p-4">
        {totalsHeader}
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
    <div className="p-4">
      {totalsHeader}

      {toolbar}

      {isLoading ? (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <div role="list" aria-label="Session archive loading">
            {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
              <SkeletonCardRow key={i} />
            ))}
          </div>
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
          <div
            {...nav.containerProps}
            role="list"
            aria-label="Session archive"
            className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
          >
            {(() => {
              const sections = sectionRows(sessions, {
                isActive: (s) => s.status === 'active',
                startedAtEpochSec: (s) => s.started_at,
              });
              // Keyboard nav was wired with items=sessions (flat array). The
              // setRowRef/cursorIndex indices must match positions in that
              // flat array, NOT positions within their section — so j/k
              // crosses section boundaries seamlessly.
              let flatIdx = 0;
              return sections.map((section) => (
                <div key={section.label}>
                  <div
                    role="separator"
                    className="flex items-center justify-between px-4 py-2 border-b border-outline-variant/20 bg-surface-container/30"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                      {section.label}
                    </span>
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      {section.rows.length}
                    </span>
                  </div>
                  {section.rows.map((session) => {
                    const idx = flatIdx++;
                    return (
                      <SessionCardRow
                        key={session.id}
                        ref={nav.setRowRef(idx)}
                        session={session}
                        symbiontDisplayName={symbiontDisplayName(session.agent)}
                        isSelected={selectedId === session.id}
                        isCursor={nav.cursorIndex === idx}
                        onClick={() => navigate(`/sessions/${session.id}`)}
                        onDelete={() => setDeleteTarget(session)}
                      />
                    );
                  })}
                </div>
              ));
            })()}
          </div>
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
