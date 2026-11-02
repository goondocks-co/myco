import { ANY, FilterBar, useFilterParams, type SelectOption } from '../../design';
import { useSessionActivity } from '../../hooks/use-sessions';
import type { SessionActivityRow } from '../../hooks/use-sessions';
import { sessionPagePath } from './Lineage';
import { SessionEventList, type SessionEventRow } from './SessionEventList';
import { agentName } from './words';

export const ACTIVITY_FILTER_KEYS = ['type'] as const;

const TYPE_WORDS: Readonly<Record<SessionActivityRow['type'], string>> = {
  child_session: 'Child session',
  continuation: 'Continuation',
};

const TYPES: readonly SelectOption[] = [
  { value: ANY, label: 'Every type' },
  ...Object.entries(TYPE_WORDS).map(([value, label]) => ({ value, label })),
];

/** The sessions related to this one; one the Project holds opens its page. */
export function SessionActivity({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const params = useFilterParams(ACTIVITY_FILTER_KEYS);
  const filters = Object.fromEntries(Object.entries(params.values).filter(([, value]) => value !== ANY));
  const activity = useSessionActivity(projectId, sessionId, filters);
  const rows = activity.rows.map((row): SessionEventRow => ({
    key: row.id,
    at: row.at,
    kind: TYPE_WORDS[row.type],
    title: row.title,
    detail: row.sessionId === null ? row.detail : `${agentName(row.agent)} · ${row.detail}`,
    ...(row.sessionId === null ? {} : { to: sessionPagePath(projectId, row.sessionId) }),
  }));
  return (
    <SessionEventList
      filterBar={<FilterBar
        filters={[{ key: 'type', label: 'Type', options: TYPES }]}
        values={params.values}
        onFilterChange={params.setFilter}
        onClear={params.clear}
      />}
      filtered={Object.keys(filters).length > 0}
      read={{ ...activity, rows }}
      noun="agent activity"
      countNoun="activity events"
      emptyTitle="No agent activity was recorded in this session."
      emptyFilteredTitle="No agent activity in this session matches these filters."
      loadingLabel="Loading agent activity"
      wrap
      now={now}
    />
  );
}
