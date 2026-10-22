import { ANY, FilterBar, useFilterParams, type SelectOption } from '../../design';
import { useSessionActivity } from '../../hooks/use-sessions';
import type { SessionActivityRow } from '../../hooks/use-sessions';
import { sessionPagePath } from './Lineage';
import { SessionEventList, type SessionEventRow } from './SessionEventList';
import { agentName } from './words';

export const ACTIVITY_FILTER_KEYS = ['type', 'tool'] as const;

const TYPE_WORDS: Readonly<Record<SessionActivityRow['type'], string>> = {
  failure: 'Failure',
  no_result: 'No result captured',
  child_session: 'Child session',
  continuation: 'Continuation',
};

const TYPES: readonly SelectOption[] = [
  { value: ANY, label: 'Every type' },
  ...Object.entries(TYPE_WORDS).map(([value, label]) => ({ value, label })),
];

/** Where a row leads: a tool row to its turn when its prompt is verified, a session row to the related session. */
function rowTarget(row: SessionActivityRow, projectId: string, sessionId: string): string | undefined {
  if (row.sessionId !== null) return sessionPagePath(projectId, row.sessionId);
  if (row.promptId !== null) return `${sessionPagePath(projectId, sessionId)}?${new URLSearchParams({ turn: row.promptId })}`;
  return undefined;
}
/** Recorded tool diagnostics and parent edges; only a verified prompt target opens a turn, and a related session the Project holds opens its page. */
export function SessionActivity({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const params = useFilterParams(ACTIVITY_FILTER_KEYS);
  const filters = Object.fromEntries(Object.entries(params.values).filter(([, value]) => value !== ANY));
  const activity = useSessionActivity(projectId, sessionId, filters);
  const selectedTool = params.values.tool ?? ANY;
  const toolNames = [...new Set([...activity.tools, ...(selectedTool === ANY ? [] : [selectedTool])])];
  const tools: SelectOption[] = [{ value: ANY, label: 'Every tool' }, ...toolNames.map((tool) => ({ value: tool, label: tool }))];
  const rows = activity.rows.map((row): SessionEventRow => {
    const to = rowTarget(row, projectId, sessionId);
    return {
      key: row.id,
      at: row.at,
      kind: TYPE_WORDS[row.type],
      title: row.title,
      detail: row.toolName === null && row.sessionId !== null ? `${agentName(row.agent)} · ${row.detail}` : row.detail,
      ...(to === undefined ? {} : { to }),
    };
  });
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
