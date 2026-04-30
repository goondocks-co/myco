import type { Env } from '../../index';
import { fetchRecord } from '../../records';
import { textJson } from '../result-shape';

interface SporesArgs {
  op?: 'list' | 'get';
  id?: string;
  machine_id?: string;
  status?: string;
  observation_type?: string;
  agent_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function handleSpores(args: SporesArgs, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const op = args.op ?? 'list';
  if (op === 'get') {
    if (!args.id) return textJson({ ok: false, error: 'id is required for op: get' });
    const record = await fetchRecord(env, 'spore', args.id, args.machine_id);
    if (!record) return textJson({ ok: false, error: 'Spore not found' });
    return textJson(record);
  }

  const { limit = 20, offset = 0 } = args;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (args.status) { conditions.push('status = ?'); binds.push(args.status); }
  if (args.observation_type) { conditions.push('observation_type = ?'); binds.push(args.observation_type); }
  if (args.agent_id) { conditions.push('agent_id = ?'); binds.push(args.agent_id); }
  if (args.search) {
    conditions.push('content LIKE ?');
    binds.push(`%${args.search}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const boundedOffset = Math.max(offset, 0);
  binds.push(boundedLimit, boundedOffset);

  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, agent_id, session_id, prompt_batch_id, observation_type, status, content, context, importance, file_path, tags, created_at, updated_at
       FROM spores ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
  ).bind(...binds).all();

  return textJson({ spores: results, offset: boundedOffset, limit: boundedLimit });
}
