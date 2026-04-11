import type { Env } from '../../index';

export async function handleTeam(env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT machine_id, package_version, schema_version, sync_protocol_version, last_seen, registered_at FROM nodes ORDER BY last_seen DESC`,
  ).all();

  return { content: [{ type: 'text' as const, text: JSON.stringify({ nodes: results }) }] };
}
