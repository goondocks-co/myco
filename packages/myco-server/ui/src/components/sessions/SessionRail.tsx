import { forwardRef, useEffect, useMemo, useRef, type RefObject } from 'react';
import { AlertCircle, GitBranch, MessageSquare } from 'lucide-react';
import { DESKTOP_BREAKPOINT } from '../ui/master-detail-split';
import { Row } from '../ui/row';
import { Skeleton } from '../ui/skeleton';
import { ActivitySparkline } from '../ui/sparkline';
import { StatusDot } from '../ui/status-dot';
import { Surface } from '../ui/surface';
import { useListKeyboardNav } from '../../hooks/use-list-keyboard-nav';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useActivity, useSessions, type SessionListFilters, type SessionSummaryRow } from '../../hooks/use-sessions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { sectionRowsWithOrder } from '../../lib/section-rows';

/** Rows that stand in for the rail while the list is still on its way. */
const SKELETON_ROWS = 5;

const SessionCard = forwardRef<HTMLDivElement, { session: SessionSummaryRow; isSelected: boolean; isCursor: boolean; onOpen: () => void }>(
  function SessionCard({ session, isSelected, isCursor, onOpen }, ref) {
    const open = session.endedAt === null;
    const moved = open ? session.lastReceivedAt : session.endedAt;
    return (
      <Row ref={ref} isActive={isSelected} isCursor={isCursor} accent="sage" onClick={onOpen} aria-label={`Session: ${session.label}`} data-selected={isSelected || undefined}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <StatusDot tone={open ? 'sage' : 'outline'} pulse={open} className="mt-1.5 shrink-0" />
            <h3 className="m-0 min-w-0 truncate font-serif text-sm italic leading-snug text-on-surface">{session.label}</h3>
          </div>
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-on-surface-variant" title={`${open ? 'last activity' : 'ended'} ${formatDateTime(moved)}`}>
            {open ? 'last' : 'ended'} {formatRelative(moved)}
          </span>
        </div>
        <div className="ml-5 mt-1.5 flex items-center justify-between gap-3">
          <div className="min-w-0 truncate font-mono text-[11px] text-on-surface-variant" title={`${session.agent ?? 'unknown agent'} · ${session.promptCount.toLocaleString()} prompts · ${session.toolCallCount.toLocaleString()} tool calls`}>
            {session.agent ?? 'unknown agent'} · {session.promptCount}p · {session.toolCallCount}t
          </div>
          <ActivitySparkline data={session.activityBuckets} kind="session" widthPx={48} heightPx={14} className="shrink-0" />
        </div>
        {session.branch !== null && (
          <div className="ml-5 mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] italic text-on-surface-variant">
            <GitBranch className="h-2.5 w-2.5" />
            {session.branch}
          </div>
        )}
      </Row>
    );
  },
);

function SkeletonRow() {
  return (
    <div className="border-b border-[var(--ghost-border)] px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Skeleton className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="ml-5 mt-1.5 h-2.5 w-40" />
    </div>
  );
}

export interface SessionRailProps {
  projectId: string;
  selectedId?: string;
  filters: SessionListFilters;
  /** True when the filter box or the state tabs narrow the list; the rail never auto-selects under a narrowed list. */
  filtered: boolean;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onSelect: (sessionId: string, options?: { replace?: boolean }) => void;
}

/** The sessions of a project as cards in sections — open first, then today, yesterday, earlier — with the project's counts on top, keyboard navigation, and the first row opened when nothing is. */
export function SessionRail({ projectId, selectedId, filters, filtered, filterInputRef, onSelect }: SessionRailProps) {
  const sessions = useSessions(projectId, filters);
  const activity = useActivity(projectId);
  const desktop = useMediaQuery(DESKTOP_BREAKPOINT);
  const { sections, orderedRows } = useMemo(
    () => sectionRowsWithOrder(sessions.rows, { isOpen: (s) => s.endedAt === null, startedAtMs: (s) => s.startedAt ?? s.firstReceivedAt }),
    [sessions.rows],
  );

  // First arrival on the list with nothing selected opens the top row, once per mount, on a wide screen only: a narrow one shows the list alone until a row is tapped.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || !desktop || filtered || selectedId !== undefined || sessions.isPending) return;
    const first = orderedRows[0];
    if (first === undefined) return;
    didAutoSelect.current = true;
    onSelect(first.sessionId, { replace: true });
  }, [desktop, filtered, selectedId, sessions.isPending, orderedRows, onSelect]);

  const nav = useListKeyboardNav({ items: orderedRows, getId: (s) => s.sessionId, selectedId, onActivate: (id) => onSelect(id), filterInputRef });
  const stats = activity.data?.stats;

  // Unfiltered, the list is the project, so the project's counts are honest; under a filter, only what the list itself holds is.
  const counts = filtered
    ? <span><strong className="font-semibold text-on-surface">{sessions.rows.length.toLocaleString()}{sessions.hasMore ? '+' : ''}</strong> SHOWN</span>
    : stats === undefined
      ? <span>—</span>
      : (
        <>
          <span><strong className="font-semibold text-on-surface">{stats.sessions.toLocaleString()}</strong> TOTAL</span>
          <span aria-hidden>·</span>
          <span><strong className="font-semibold text-on-surface">{stats.openSessions.toLocaleString()}</strong> OPEN</span>
          <span aria-hidden>·</span>
          <span><strong className="font-semibold text-on-surface">{stats.prompts.toLocaleString()}</strong> PROMPTS</span>
        </>
      );

  const header = (
    <div className="border-b border-[var(--ghost-border)] px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="myco-eyebrow-sm">Sessions</span>
        <span className="myco-display-sm text-on-surface">History</span>
      </div>
      <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-variant" data-testid="rail-counts">{counts}</div>
    </div>
  );

  if (sessions.error) {
    return (
      <div>
        {header}
        <div className="mt-4 flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">The sessions could not be read</span>
          <span className="font-sans text-xs text-on-surface-variant">{sessions.error.message}</span>
        </div>
      </div>
    );
  }

  let flatIdx = 0;
  return (
    <div>
      {header}
      {sessions.isPending ? (
        <div role="status" aria-label="Loading sessions">
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      ) : sessions.rows.length === 0 ? (
        <div className="mt-4 flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
          <MessageSquare className="h-8 w-8 opacity-30" />
          <span className="font-sans text-sm">{filtered ? 'No sessions match.' : 'No sessions yet'}</span>
          {!filtered && <span className="font-sans text-xs">Sessions appear here as your runtimes capture them.</span>}
        </div>
      ) : (
        <Surface level="low" className="overflow-hidden">
          <div {...nav.containerProps} role="table" aria-label="Sessions" className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/40">
            {sections.map((section) => (
              <div key={section.label}>
                <div role="separator" className="flex items-center justify-between border-b border-[var(--ghost-border)] bg-surface-container/40 px-4 py-2">
                  <span className="myco-eyebrow-sm">{section.label}</span>
                  <span className="font-mono text-[10px] text-outline">{section.rows.length}</span>
                </div>
                {section.rows.map((session) => {
                  const idx = flatIdx++;
                  return (
                    <SessionCard
                      key={session.sessionId}
                      ref={nav.setRowRef(idx)}
                      session={session}
                      isSelected={selectedId === session.sessionId}
                      isCursor={nav.cursorIndex === idx}
                      onOpen={() => onSelect(session.sessionId)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </Surface>
      )}
      {sessions.hasMore && (
        <div className="p-3">
          <button type="button" disabled={sessions.isFetchingMore} onClick={sessions.more} className="rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50">Load more</button>
        </div>
      )}
    </div>
  );
}
