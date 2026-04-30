import type { Env } from '../../index';
import { fetchRecord } from '../../records';
import { textJson } from '../result-shape';

export async function handleSkills(args: { op?: 'list' | 'get'; id?: string; machine_id?: string; status?: string; limit?: number }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const op = args.op ?? 'list';
  if (op === 'get') {
    if (!args.id) return textJson({ ok: false, error: 'id is required for op: get' });
    const row = await fetchRecord(env, 'skill', args.id, args.machine_id)
      ?? await fetchRecord(env, 'skill', await resolveSkillIdByName(env, args.id, args.machine_id), args.machine_id);
    if (!row) return textJson({ ok: false, error: 'Skill not found' });
    return textJson(row);
  }

  const { status, limit = 50 } = args;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status) { conditions.push('status = ?'); binds.push(status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  binds.push(Math.min(Math.max(limit, 1), 100));

  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, name, display_name, description, status, generation, usage_count, last_used_at, created_at, updated_at FROM skill_records ${where} ORDER BY usage_count DESC, created_at DESC LIMIT ?`,
  ).bind(...binds).all();

  return textJson({ skills: results });
}

async function resolveSkillIdByName(
  env: Pick<Env, 'MYCO_TEAM_DB'>,
  name: string,
  machineId?: string,
): Promise<string> {
  const statement = machineId
    ? env.MYCO_TEAM_DB.prepare('SELECT id FROM skill_records WHERE name = ? AND machine_id = ? LIMIT 1').bind(name, machineId)
    : env.MYCO_TEAM_DB.prepare('SELECT id FROM skill_records WHERE name = ? LIMIT 1').bind(name);
  const row = await statement.first<{ id: string }>();
  return row?.id ?? name;
}
