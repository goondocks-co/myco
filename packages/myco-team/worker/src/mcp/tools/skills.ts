import type { Env } from '../../index';

export async function handleSkills(args: { status?: string; limit?: number }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const { status, limit = 50 } = args;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status) { conditions.push('status = ?'); binds.push(status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  binds.push(Math.min(Math.max(limit, 1), 100));

  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, name, display_name, description, status, generation, usage_count, last_used_at, created_at, updated_at FROM skill_records ${where} ORDER BY usage_count DESC, created_at DESC LIMIT ?`,
  ).bind(...binds).all();

  return { content: [{ type: 'text' as const, text: JSON.stringify({ skills: results }) }] };
}
