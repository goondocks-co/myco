import { EmptyState, ErrorState, LaneTimeline, LoadingState, type Lane } from '../../design';
import { useSessionLineage, type LineageEdge, type LineageNode, type SessionLineage } from '../../hooks/use-sessions';
import { projectPath } from '../../routes/nav';
import { agentName, clockTime, dateTime } from './words';

/** The name of a session a record names but the Project does not hold. */
export const NOT_CAPTURED_NAME = 'A session not captured here';

/** A related session's page; it opens on its conversation. */
export function sessionPagePath(projectId: string, sessionId: string): string {
  return projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`);
}

/** A node's name as the lineage shows it. */
export function lineageName(node: LineageNode | undefined): string {
  return node === undefined || !node.captured ? NOT_CAPTURED_NAME : node.label ?? 'Untitled session';
}

/** How a child stands to one of its parents, in words. */
export function parentWords(edge: LineageEdge, parent: string): string {
  if (edge.kind === 'launched') return `Child of ${parent}`;
  return `Continues ${parent}${edge.reason === null ? '' : ` (${edge.reason})`}`;
}

function spanWords(node: LineageNode, now: number): string {
  if (node.startedAt === null) return 'Times not captured';
  if (node.endedAt === null) return `${dateTime(node.startedAt, now)} – no end recorded`;
  const sameDay = new Date(node.startedAt).toDateString() === new Date(node.endedAt).toDateString();
  return `${dateTime(node.startedAt, now)} – ${sameDay ? clockTime(node.endedAt) : dateTime(node.endedAt, now)}`;
}

const sameEdge = (edge: LineageEdge, other: LineageEdge | null): boolean =>
  other !== null && edge.parentId === other.parentId && edge.kind === other.kind;

/** The lineage as nested lanes: each node under the one it is placed under, its other parents named in its detail. */
export function lineageLanes(lineage: SessionLineage, projectId: string, now: number): Lane[] {
  const byId = new Map(lineage.nodes.map((node) => [node.sessionId, node]));
  const lanes = new Map<string, Lane & { lanes: Lane[] }>();
  const roots: Lane[] = [];
  for (const node of lineage.nodes) {
    const relations = lineage.edges.filter((edge) => edge.childId === node.sessionId).map((edge) =>
      sameEdge(edge, node.placedUnder)
        ? (edge.kind === 'launched' ? 'Child session' : parentWords(edge, 'its parent'))
        : parentWords(edge, lineageName(byId.get(edge.parentId))));
    const lane: Lane & { lanes: Lane[] } = {
      key: node.sessionId,
      name: lineageName(node),
      ...(node.captured && !node.current ? { to: sessionPagePath(projectId, node.sessionId) } : {}),
      detail: node.captured ? [agentName(node.agent), ...(node.current ? ['This session'] : []), ...relations].join(' · ') : relations.join(' · ') || undefined,
      when: spanWords(node, now),
      start: node.startedAt,
      end: node.endedAt,
      current: node.current,
      lanes: [],
    };
    lanes.set(node.sessionId, lane);
    const parent = node.placedUnder === null ? undefined : lanes.get(node.placedUnder.parentId);
    if (parent === undefined) roots.push(lane); else parent.lanes.push(lane);
  }
  return roots;
}

/** The session's family over its parent and child sessions, the session itself marked. */
export function SessionLineageTab({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const lineage = useSessionLineage(projectId, sessionId);
  if (lineage.isPending) return <LoadingState label="Loading the lineage" count={3} />;
  if (lineage.error) return <ErrorState error={lineage.error} onRetry={() => void lineage.refetch()} />;
  if (lineage.data.nodes.length <= 1) return <EmptyState title="No parent or child sessions were recorded for this session." />;
  return (
    <div className="flex flex-col gap-s3 rounded-card border border-line bg-surface-1 p-s3" data-lineage="">
      <LaneTimeline lanes={lineageLanes(lineage.data, projectId, now)} label="Lineage" now={now} />
      {lineage.data.truncated && <p className="px-s3 t-small text-muted">Only part of this family is shown: it reaches past what one page reads.</p>}
    </div>
  );
}
