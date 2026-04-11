import type { Env } from '../../index';

const TYPE_TO_TABLE: Record<string, string> = {
  session: 'sessions', spore: 'spores', plan: 'plans', artifact: 'artifacts', skill: 'skill_records',
};

export async function handleGet(args: { id: string; type: string }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const table = TYPE_TO_TABLE[args.type];
  if (!table) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown type: ${args.type}` }) }] };

  const row = await env.MYCO_TEAM_DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).bind(args.id).first<Record<string, unknown>>();
  if (!row) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `${args.type} '${args.id}' not found` }) }] };

  return { content: [{ type: 'text' as const, text: JSON.stringify(row) }] };
}
