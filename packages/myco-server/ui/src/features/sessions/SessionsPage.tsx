import { useMemo, type ReactNode } from 'react';
import {
  Button, DataTable, dayLabel, EmptyState, ErrorState, FilterBar, LoadingState, ShowMore, StatusChip, useFilterParams, useQueryDraft,
  type DataTableColumn, type DataTableGroup,
} from '../../design';
import { useMembers } from '../../hooks/use-access';
import { useSessionList } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { cleanSessionText, sessionHeading } from '../../lib/session-text';
import { projectPath } from '../../routes/nav';
import { isLive, sessionAt } from '../today/timeline';
import type { SessionListRow } from './wire';
import { agentFilter, agentName, clockTime, count, memberFilter, SESSION_FILTER_KEYS, STATE_FILTER, WINDOW_FILTER, windowSince } from './words';

/** How long the search box waits after the last keystroke before the list is read again. */
const FILTER_DEBOUNCE_MS = 250;

export interface SessionsPageProps {
  /** The project the list is narrowed to, or null for every project. */
  projectId: string | null;
  /** A project's name by its id, or null when the dashboard does not know it. */
  projectName: (projectId: string) => string | null;
}

/**
 * Sessions as a table, across every project at `/sessions` and narrowed to one
 * at `/p/:project/sessions`: grouped by the day each started, newest first, a
 * row per session with its summary's first line. The search and the filters
 * live in the query string, the server does the filtering, and "Show more"
 * reads the next page. While a listed session is live the list reads itself
 * again every 30 s.
 */
export function SessionsPage({ projectId, projectName }: SessionsPageProps) {
  const now = useNow();
  const filterParams = useFilterParams(SESSION_FILTER_KEYS);
  const { values } = filterParams;
  const draft = useQueryDraft(filterParams.query, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const members = useMembers();
  const since = windowSince(values.window ?? 'all', now);
  const list = useSessionList({
    projectId,
    state: values.state === 'open' || values.state === 'ended' ? values.state : undefined,
    q: filterParams.query,
    agent: values.agent === 'all' ? undefined : values.agent,
    member: values.member === 'all' ? undefined : values.member,
    since,
  });
  const filtered = filterParams.query !== '' || SESSION_FILTER_KEYS.some((key) => values[key] !== 'all');
  const clear = () => { draft.reset(); filterParams.clear(); };

  const filters = [
    agentFilter(list.rows.map((row) => row.agent), values.agent ?? 'all'),
    memberFilter(members.data?.members ?? [], values.member ?? 'all'),
    STATE_FILTER,
    WINDOW_FILTER,
  ];
  const groups = useMemo(() => byDay(list.rows, now), [list.rows, now]);
  const scopedName = projectId === null ? null : projectName(projectId) ?? 'this project';

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
      <Table
        rows={list.rows}
        groups={groups}
        pending={list.isPending}
        error={list.error}
        onRetry={list.retry}
        scoped={projectId !== null}
        projectName={projectName}
        now={now}
        empty={filtered
          ? <EmptyState title="No sessions match." action={<Button variant="ghost" size="sm" onClick={clear}>Clear the search and filters</Button>} />
          : <EmptyState title="No sessions yet. Sessions appear here as your agents capture them." />}
      />
      {list.rows.length > 0 && <ShowMore shown={list.rows.length} noun={list.rows.length === 1 ? 'session' : 'sessions'} onMore={list.more} pending={list.isFetchingMore} hasMore={list.hasMore} />}
    </div>
  );
}

/** The listed sessions under the day each started, in the order the server gave them. */
function byDay(rows: readonly SessionListRow[], now: number): DataTableGroup<SessionListRow>[] {
  const groups: DataTableGroup<SessionListRow>[] = [];
  for (const row of rows) {
    const label = dayLabel(sessionAt(row), now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) (last.rows as SessionListRow[]).push(row);
    else groups.push({ key: `${label}/${groups.length}`, label, rows: [row] });
  }
  return groups;
}

interface TableProps {
  rows: readonly SessionListRow[];
  groups: DataTableGroup<SessionListRow>[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  scoped: boolean;
  projectName: (projectId: string) => string | null;
  now: number;
  empty: ReactNode;
}

function Table({ rows, groups, pending, error, onRetry, scoped, projectName, now, empty }: TableProps) {
  if (pending) return <LoadingState label="Loading sessions" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (rows.length === 0) return <>{empty}</>;
  const project = (row: SessionListRow) => projectName(row.projectId) ?? 'A project';
  const started = (row: SessionListRow) => (isLive(row, now) ? 'now' : clockTime(sessionAt(row)));
  const columns: DataTableColumn<SessionListRow>[] = [
    { key: 'session', header: 'Session', cell: (row) => <SessionHeadline row={row} live={isLive(row, now)} /> },
    ...(scoped ? [] : [{ key: 'project', header: 'Project', width: 'lg' as const, cell: project }]),
    { key: 'agent', header: 'Agent', width: 'md', cell: (row) => agentName(row.agent) },
    { key: 'size', header: 'Size', width: 'md', align: 'end', cell: (row) => count(row.promptCount, 'prompt') },
    { key: 'started', header: 'Started', width: 'sm', align: 'end', cell: (row) => <time dateTime={new Date(sessionAt(row)).toISOString()}>{started(row)}</time> },
  ];
  return (
    <DataTable
      label="Sessions"
      columns={columns}
      groups={groups}
      rowKey={(row) => `${row.projectId}/${row.sessionId}`}
      rowHref={(row) => projectPath(row.projectId, `/sessions/${encodeURIComponent(row.sessionId)}`)}
      detail={(row) => cleanSessionText(row.summary)}
      phoneMeta={(row) => [scoped ? null : project(row), agentName(row.agent), count(row.promptCount, 'prompt'), started(row)].filter(Boolean).join(' · ')}
      rowData={(row) => ({ 'data-live': isLive(row, now) ? '' : undefined })}
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
