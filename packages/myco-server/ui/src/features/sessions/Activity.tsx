import { ANY, FilterBar, useFilterParams, type SelectOption } from '../../design';
import { useSessionActivity } from '../../hooks/use-sessions';
import { projectPath } from '../../routes/nav';
import { SessionEventList, type SessionEventRow } from './SessionEventList';

export const ACTIVITY_FILTER_KEYS = ['type', 'tool'] as const;

const TYPES: readonly SelectOption[] = [
  { value: ANY, label: 'Every type' },
  { value: 'failure', label: 'Failure' },
  { value: 'no_result', label: 'No result captured' },
];
/** Recorded tool diagnostics; only a verified prompt target opens a turn. */
export function SessionActivity({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const params = useFilterParams(ACTIVITY_FILTER_KEYS);
  const filters = Object.fromEntries(Object.entries(params.values).filter(([, value]) => value !== ANY));
  const activity = useSessionActivity(projectId, sessionId, filters);
  const selectedTool = params.values.tool ?? ANY;
  const toolNames = [...new Set([...activity.tools, ...(selectedTool === ANY ? [] : [selectedTool])])];
  const tools: SelectOption[] = [{ value: ANY, label: 'Every tool' }, ...toolNames.map((tool) => ({ value: tool, label: tool }))];
  const rows = activity.rows.map((row): SessionEventRow => ({
    key: row.id,
    at: row.at,
    kind: row.type === 'failure' ? 'Failure' : 'No result captured',
    title: row.title,
    detail: row.detail,
    ...(row.promptId === null ? {} : { to: `${projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`)}?${new URLSearchParams({ turn: row.promptId })}` }),
  }));
  return (
    <SessionEventList
      filterBar={<FilterBar
        filters={[
          { key: 'type', label: 'Type', options: TYPES },
          { key: 'tool', label: 'Tool', options: tools },
        ]}
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
