import type { Env } from '../../index';
import { fetchRecord } from '../../records';
import { textJson } from '../result-shape';

interface PlansArgs {
  op?: 'list' | 'get';
  id?: string;
  machine_id?: string;
  status?: string;
  session?: string;
  limit?: number;
}

export async function handlePlans(args: PlansArgs, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const op = args.op ?? 'list';
  if (op === 'get') {
    if (!args.id) return textJson({ ok: false, error: 'id is required for op: get' });
    const record = await fetchRecord(env, 'plan', args.id, args.machine_id);
    if (!record) return textJson({ ok: false, error: 'Plan not found' });
    return textJson(record);
  }

  const { limit = 20, status, session } = args;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status) { conditions.push('status = ?'); binds.push(status); }
  if (session) { conditions.push('session_id = ?'); binds.push(session); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  binds.push(Math.min(Math.max(limit, 1), 100));

  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, logical_key, status, author, title, SUBSTR(content, 1, 500) as preview, source_path, tags, session_id, prompt_batch_id, created_at, updated_at
       FROM plans ${where}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
  ).bind(...binds).all();

  return textJson({ plans: results });
}
