import type { Env } from '../../index';

export async function handleGraph(
  args: { node_id: string; direction?: string },
  env: Pick<Env, 'MYCO_TEAM_DB'>,
) {
  const { node_id, direction = 'both' } = args;
  let edgeCondition: string;
  const edgeBinds: string[] = [];

  if (direction === 'outgoing') { edgeCondition = 'source_id = ?'; edgeBinds.push(node_id); }
  else if (direction === 'incoming') { edgeCondition = 'target_id = ?'; edgeBinds.push(node_id); }
  else { edgeCondition = '(source_id = ? OR target_id = ?)'; edgeBinds.push(node_id, node_id); }

  const { results: edges } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, source_id, source_type, target_id, target_type, type, confidence, properties FROM graph_edges WHERE ${edgeCondition} LIMIT 100`,
  ).bind(...edgeBinds).all();

  const entityIds = new Set<string>();
  for (const edge of edges as Array<Record<string, unknown>>) {
    if (edge.source_type === 'entity') entityIds.add(edge.source_id as string);
    if (edge.target_type === 'entity') entityIds.add(edge.target_id as string);
  }

  let entities: Record<string, unknown>[] = [];
  if (entityIds.size > 0) {
    const placeholders = [...entityIds].map(() => '?').join(', ');
    const { results } = await env.MYCO_TEAM_DB.prepare(
      `SELECT id, type, name, properties, first_seen, last_seen FROM entities WHERE id IN (${placeholders})`,
    ).bind(...entityIds).all();
    entities = results as Record<string, unknown>[];
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify({ node_id, edges, entities }) }] };
}
