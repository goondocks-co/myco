import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, DataTable, dayLabel, EmptyState, ErrorState, FilterBar, LoadingState, ShowMore, StatusChip, useFilterParams, useQueryDraft,
  type DataTableColumn, type DataTableGroup,
} from '../../design';
import { useMembers } from '../../hooks/use-access';
import { useLiveSessions, useSessionList } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { cleanSessionText, sessionHeading } from '../../lib/session-text';
import { projectPath } from '../../routes/nav';
import { sessionAt } from '../today/timeline';
import type { SessionListRow } from './wire';
import { agentFilter, agentName, count, memberFilter, SESSION_FILTER_KEYS, startedWords, STATE_FILTER, WINDOW_FILTER, windowBounds } from './words';

/** How long the search box waits after the last keystroke before the list is read again. */
const FILTER_DEBOUNCE_MS = 250;

/** The label of the group that holds the sessions live now, above the days. */
export const LIVE_GROUP = 'Live now';

export interface SessionsPageProps {
  /** The project the list is narrowed to, or null for every project. */
  projectId: string | null;
  /** A project's name by its id, or null when the dashboard does not know it. */
  projectName: (projectId: string) => string | null;
}

const rowKey = (row: SessionListRow) => `${row.projectId}/${row.sessionId}`;

/**
 * Sessions as a table, across every project at `/sessions` and narrowed to one
 * at `/p/:project/sessions`. The sessions live now sit in their own group on
 * top, read on their own so a live session older than the first page still
 * shows; the rest follow under the day each started, newest first. The search
 * and the filters live in the query string, the server does the filtering, and
 * "Show more" reads the next page. While a session is live the live group reads
 * itself again every 30 s; the pages below are read again on focus.
 */
export function SessionsPage({ projectId, projectName }: SessionsPageProps) {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const filterParams = useFilterParams(SESSION_FILTER_KEYS);
  const { values } = filterParams;
  const draft = useQueryDraft(filterParams.query, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const members = useMembers();
  const bounds = windowBounds(values.window ?? 'all', now);
  const branch = params.get('branch') ?? undefined;
  const shared = {
    projectId,
    q: filterParams.query,
    agent: values.agent === 'all' ? undefined : values.agent,
    member: values.member === 'all' ? undefined : values.member,
    branch,
  };
  const list = useSessionList({
    ...shared,
    state: values.state === 'open' || values.state === 'ended' ? values.state : undefined,
    ...(bounds === null ? {} : { active: bounds }),
  });
  // An ended session is never live, so a list narrowed to ended sessions has no live group.
  const live = useLiveSessions(shared, values.state !== 'ended');
  const liveRows = values.state === 'ended' ? [] : live.data?.rows ?? [];
  const filtered = filterParams.query !== '' || branch !== undefined || SESSION_FILTER_KEYS.some((key) => values[key] !== 'all');
  // One write to the URL: the search, every filter and the branch go together.
  const clear = () => {
    draft.reset();
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ['q', 'branch', ...SESSION_FILTER_KEYS]) next.delete(key);
      return next;
    }, { replace: true });
  };

  const filters = [
    agentFilter(list.rows.map((row) => row.agent), values.agent ?? 'all'),
    memberFilter(members.data?.members ?? [], values.member ?? 'all'),
    STATE_FILTER,
    WINDOW_FILTER,
  ];
  const liveKeys = useMemo(() => new Set(liveRows.map(rowKey)), [liveRows]);
  const groups = useMemo(() => grouped(liveRows, list.rows.filter((row) => !liveKeys.has(rowKey(row))), now), [liveRows, list.rows, liveKeys, now]);
  const scopedName = projectId === null ? null : projectName(projectId) ?? 'this project';
  const shown = liveRows.length + list.rows.filter((row) => !liveKeys.has(rowKey(row))).length;

  return (
    <div className="flex w-full flex-col gap-s5" data-sessions-page="">
      <div className="flex flex-col gap-s2">
        <h1 className="t-display text-ink">Sessions</h1>
        <p className="t-body text-muted">
          {scopedName === null ? 'Every session your agents ran, across all projects.' : `Every session your agents ran in ${scopedName}.`}
        </p>
      </div>
      <FilterBar
        searchLabel="Filter sessions"
        placeholder="Search by title, first prompt, agent or branch"
        query={draft.text}
        onQueryChange={draft.setText}
        filters={filters}
        values={values}
        onFilterChange={filterParams.setFilter}
        onClear={clear}
      />
      {branch !== undefined && (
        <p className="flex flex-wrap items-center gap-s2 t-small text-muted" data-branch-filter="">
          On branch <span className="t-mono text-ink-2">{branch}</span>
          <Button variant="ghost" size="sm" onClick={() => setParams((current) => { const next = new URLSearchParams(current); next.delete('branch'); return next; }, { replace: true })}>
            Every branch
          </Button>
        </p>
      )}
      <Table
        count={shown}
        groups={groups}
        pending={list.isPending}
        error={list.error}
        onRetry={list.retry}
        scoped={projectId !== null}
        projectName={projectName}
        liveKeys={liveKeys}
        periodStart={bounds?.since}
        now={now}
        empty={filtered
          ? <EmptyState title="No sessions match." action={<Button variant="ghost" size="sm" onClick={clear}>Clear the search and filters</Button>} />
          : <EmptyState title="No sessions yet. Sessions appear here as your agents capture them." />}
      />
      {shown > 0 && <ShowMore shown={shown} noun={shown === 1 ? 'session' : 'sessions'} onMore={list.more} pending={list.isFetchingMore} hasMore={list.hasMore} />}
    </div>
  );
}

/** The live sessions on top, then the rest under the day each started, in the order the server gave them. */
function grouped(live: readonly SessionListRow[], rows: readonly SessionListRow[], now: number): DataTableGroup<SessionListRow>[] {
  const groups: DataTableGroup<SessionListRow>[] = live.length === 0 ? [] : [{ key: 'live', label: LIVE_GROUP, rows: live }];
  for (const row of rows) {
    const label = dayLabel(sessionAt(row), now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key !== 'live' && last.label === label) (last.rows as SessionListRow[]).push(row);
    else groups.push({ key: `${label}/${groups.length}`, label, rows: [row] });
  }
  return groups;
}

/** The first instant of the day an instant falls on. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface TableProps {
  count: number;
  groups: DataTableGroup<SessionListRow>[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  scoped: boolean;
  projectName: (projectId: string) => string | null;
  /** The sessions live now, by `project/session`. */
  liveKeys: ReadonlySet<string>;
  /** The start of the period the Active filter covers, when it is set. */
  periodStart: number | undefined;
  now: number;
  empty: ReactNode;
}

function Table({ count: rows, groups, pending, error, onRetry, scoped, projectName, liveKeys, periodStart, now, empty }: TableProps) {
  if (pending) return <LoadingState label="Loading sessions" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (rows === 0) return <>{empty}</>;
  const project = (row: SessionListRow) => projectName(row.projectId) ?? 'A project';
  const isLiveRow = (row: SessionListRow) => liveKeys.has(rowKey(row));
  // A live row started before today, and a row that started before the Active period, say since when.
  const started = (row: SessionListRow) => startedWords(sessionAt(row), isLiveRow(row) ? startOfDay(now) : periodStart ?? -Infinity, now);
  const columns: DataTableColumn<SessionListRow>[] = [
    { key: 'session', header: 'Session', cell: (row) => <SessionHeadline row={row} live={isLiveRow(row)} /> },
    ...(scoped ? [] : [{ key: 'project', header: 'Project', width: 'lg' as const, cell: project }]),
    { key: 'agent', header: 'Agent', width: 'md', cell: (row) => agentName(row.agent) },
    { key: 'size', header: 'Size', width: 'md', align: 'end', cell: (row) => count(row.promptCount, 'prompt') },
    { key: 'started', header: 'Started', width: 'lg', align: 'end', cell: (row) => <time dateTime={new Date(sessionAt(row)).toISOString()}>{started(row)}</time> },
  ];
  return (
    <DataTable
      label="Sessions"
      columns={columns}
      groups={groups}
      rowKey={rowKey}
      rowHref={(row) => projectPath(row.projectId, `/sessions/${encodeURIComponent(row.sessionId)}`)}
      detail={(row) => cleanSessionText(row.summary)}
      phoneMeta={(row) => [scoped ? null : project(row), agentName(row.agent), count(row.promptCount, 'prompt'), started(row)].filter(Boolean).join(' · ')}
      rowData={(row) => ({ 'data-live': isLiveRow(row) ? '' : undefined })}
    />
  );
}

/** A session's headline: Live when it is, then its title, or its first prompt marked Untitled. */
function SessionHeadline({ row, live }: { row: SessionListRow; live: boolean }) {
  const heading = sessionHeading(row);
  return (
    <>
      {live && (
        <StatusChip tone="ok" className="mr-s2 align-text-bottom">
          <span aria-hidden className="size-s2 rounded-pill bg-ok motion-safe:animate-pulse" />
          Live
        </StatusChip>
      )}
      {heading.titled ? heading.title : heading.firstPrompt === null
        ? <span className="font-normal text-muted">Untitled session</span>
        : <><StatusChip className="mr-s2 align-text-bottom">Untitled</StatusChip>{heading.firstPrompt}</>}
    </>
  );
}
