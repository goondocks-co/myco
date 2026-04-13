import type { Env } from '../../index';

export async function handleSessions(
  args: { limit?: number; status?: string; agent?: string; branch?: string; since?: string },
  env: Pick<Env, 'MYCO_TEAM_DB'>,
) {
  const { limit = 20, status, agent, branch, since } = args;
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (status) { conditions.push('status = ?'); binds.push(status); }
  if (agent) { conditions.push('agent = ?'); binds.push(agent); }
  if (branch) { conditions.push('branch = ?'); binds.push(branch); }
  if (since) { conditions.push('started_at >= ?'); binds.push(Math.floor(new Date(since).getTime() / 1000)); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  binds.push(Math.min(Math.max(limit, 1), 100));

  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, agent, "user", branch, status, title, SUBSTR(summary, 1, 300) as summary, prompt_count, tool_count, started_at, ended_at FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`,
  ).bind(...binds).all();

  return { content: [{ type: 'text' as const, text: JSON.stringify({ sessions: results }) }] };
}
