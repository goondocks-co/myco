import type { Env } from '../../index';
import { fetchRecord } from '../../records';
import { textJson } from '../result-shape';

export async function handleSessions(
  args: { op?: 'list' | 'get'; id?: string; machine_id?: string; limit?: number; status?: string; agent?: string; branch?: string; since?: string },
  env: Pick<Env, 'MYCO_TEAM_DB'>,
) {
  const op = args.op ?? 'list';
  if (op === 'get') {
    if (!args.id) return textJson({ ok: false, error: 'id is required for op: get' });
    const record = await fetchRecord(env, 'session', args.id, args.machine_id);
    if (!record) return textJson({ ok: false, error: 'Session not found' });
    return textJson(record);
  }

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

  return textJson({ sessions: results });
}
