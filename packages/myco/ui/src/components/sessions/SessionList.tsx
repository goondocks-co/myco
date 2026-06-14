import { useLocation } from 'react-router-dom';
import { AlertCircle, GitBranch, MessageSquare, Trash2 } from 'lucide-react';
import { Surface } from '../ui/surface';
import { Row } from '../ui/row';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Pagination } from '../ui/pagination';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { ActivitySparkline } from '../ui/sparkline';
import { useSessions, useDeleteSession, useSessionImpact, type SessionSummary } from '../../hooks/use-sessions';
import { ApiError } from '../../lib/api';
import { useSymbionts } from '../../hooks/use-symbionts';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { shortSession, formatEpochAgo } from '../../lib/format';
import { ReleaseStateDot } from '../release-state/ReleaseStateBadge';
import { sectionRows } from '../../lib/section-rows';
import { forwardRef, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useListKeyboardNav } from '../../hooks/use-list-keyboard-nav';

/* ---------- Constants ---------- */

/** Number of skeleton rows to show during loading. */
const SKELETON_ROW_COUNT = 5;

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
    <Row
      ref={ref}
      isActive={isSelected}
      isCursor={isCursor}
      accent="sage"
      onClick={onClick}
      aria-label={`Session: ${sessionLabel}`}
      data-selected={isSelected || undefined}
      className="group"
    >
      {/* Top row: status + title on the left, time + actions on the right */}
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
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-terracotta/10 hover:text-terracotta transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-terracotta/40"
            aria-label={`Delete session ${sessionLabel}`}
            title="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Meta line: agent · symbiont · prompts · tools */}
      <div className="mt-1.5 ml-5 flex items-center justify-between gap-3">
        <div className="min-w-0 truncate font-mono text-[11px] text-on-surface-variant">
          {session.agent} · {symbiontDisplayName} · {session.prompt_count}p · {session.tool_count}t
        </div>
        <ActivitySparkline
          data={session.activity_buckets}
          kind="session"
          widthPx={48}
          heightPx={14}
          className="shrink-0"
        />
      </div>

      {/* Branch line: rendered only when a branch was captured */}
      {session.branch && (
        <div className="mt-0.5 ml-5 inline-flex items-center gap-1 font-mono text-[10px] italic text-on-surface-variant">
          <GitBranch className="h-2.5 w-2.5" />
          {session.branch}
        </div>
      )}
    </Row>
  );
});

function SkeletonCardRow() {
  return (
    <div className="border-b border-[var(--ghost-border)] last:border-b-0 px-4 py-3">
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
  /** Debounced search string from the page-level filter bar. */
  search?: string;
  /** Active filter values from the page-level filter bar (undefined = all). */
  statusFilter?: string;
  agentFilter?: string;
  hasPlanFilter?: boolean;
  /** Pagination state (owned by the page so it resets when filters change). */
  offset: number;
  onOffsetChange: (offset: number) => void;
  /** Search-input ref from the page filter bar — passed to keyboard nav so
   * the `/` shortcut focuses the page-level input. */
  filterInputRef?: RefObject<HTMLInputElement | null>;
  onSelectSession: (id: string, options?: { replace?: boolean }) => void;
}

export function SessionList({
  selectedId,
  search,
  statusFilter,
  agentFilter,
  hasPlanFilter,
  offset,
  onOffsetChange,
  filterInputRef,
  onSelectSession,
}: SessionListProps) {
  const location = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  // Second-stage confirm: set when the daemon refused the delete with 409
  // session_live; the next confirm retries with force.
  const [liveConfirm, setLiveConfirm] = useState(false);
  const deleteSession = useDeleteSession();
  const { data: impact } = useSessionImpact(deleteTarget?.id ?? null);
  const { data: symbiontsData } = useSymbionts();

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

  const { data, isLoading, isError, error } = useSessions({
    limit: DEFAULT_PAGE_SIZE,
    offset,
    status: statusFilter,
    agent: agentFilter,
    hasPlan: hasPlanFilter,
    search,
  });

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    deleteSession.mutate({ id: deleteTarget.id, force: liveConfirm }, {
      onSuccess: () => {
        setDeleteTarget(null);
        setLiveConfirm(false);
      },
      onError: (err) => {
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          (err.body as { error?: string } | null)?.error === 'session_live'
        ) {
          setLiveConfirm(true);
        }
      },
    });
  }

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;

  // Master-detail default: on first arrival at /sessions with no row
  // selected, jump to the topmost entry. The `didAutoSelect` ref makes
  // it a true one-shot per mount — without the guard, every poll
  // refetch re-references the `sessions` array and re-fires the
  // navigate, which corrupts back-button history if the user has
  // since navigated to `/sessions/<id>` and then back to `/sessions`.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current) return;
    // Skip auto-select when a deep-link has applied a SPECIFIC filter
    // we know about (status / agent / has_plan). Jumping to the first
    // session would unmount the route and lose the filter on remount.
    // Important: only latch `didAutoSelect` when an auto-select
    // actually fires — skipping here without latching keeps the
    // effect alive so that clearing the filters in the same mount
    // (via the dropdowns) restores auto-select on the next render.
    const params = new URLSearchParams(location.search);
    const hasDeepLinkFilter =
      params.has('status') || params.has('agent') || params.has('has_plan');
    if (hasDeepLinkFilter) return;
    if (!selectedId && !isLoading && sessions.length > 0) {
      didAutoSelect.current = true;
      onSelectSession(sessions[0].id, { replace: true });
    }
  }, [selectedId, isLoading, sessions, onSelectSession, location.search]);

  const nav = useListKeyboardNav({
    items: sessions,
    getId: (s) => s.id,
    selectedId,
    onActivate: (id) => onSelectSession(id),
    filterInputRef,
  });

  // Page-local sums: aggregates reflect the visible page only. The sessions
  // query doesn't expose project-scoped totals for prompts/active-status
  // separately, so we sum what's loaded. TOTAL comes from the paginated
  // query response (server-wide for the current filter).
  const activeCount = sessions.filter((s) => s.status === 'active').length;
  const promptsTotal = sessions.reduce((sum, s) => sum + (s.prompt_count ?? 0), 0);

  const totalsHeader = (
    <div className="px-4 py-3 border-b border-[var(--ghost-border)]">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="myco-eyebrow-sm">Sessions</h2>
        <span className="myco-display-sm text-on-surface">Archive</span>
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
      <div>
        {totalsHeader}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-terracotta mt-4">
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
      {totalsHeader}

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
            {total === 0 && !search && !statusFilter && !agentFilter
              ? 'No sessions yet'
              : 'No matching sessions'}
          </span>
          {total === 0 && !search && !statusFilter && !agentFilter && (
            <span className="font-sans text-xs">Sessions appear here as you work with your agent</span>
          )}
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <div
            {...nav.containerProps}
            role="list"
            aria-label="Session archive"
            className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/40"
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
                    className="flex items-center justify-between px-4 py-2 border-b border-[var(--ghost-border)] bg-surface-container/40"
                  >
                    <span className="myco-eyebrow-sm">{section.label}</span>
                    <span className="font-mono text-[10px] text-outline">
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
                        onClick={() => onSelectSession(session.id)}
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
        onPageChange={onOffsetChange}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setLiveConfirm(false); } }}
        title="Delete Session"
        description={liveConfirm
          ? 'Session appears live — the agent is still running. Deleting now permanently discards the rest of the session as it happens. Delete anyway?'
          : 'This will permanently remove this session and all related data. This action cannot be undone.'}
        icon={<Trash2 className="h-4 w-4 text-terracotta" />}
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
        confirmLabel={liveConfirm ? 'Delete Anyway' : 'Delete Session'}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        isPending={deleteSession.isPending}
      />
    </div>
  );
}
