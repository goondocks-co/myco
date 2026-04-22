import type { Env } from '../../index';
import { fetchRecord, resolveTable } from '../../records';

export async function handleRecall(args: { id: string; type: string }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  if (!resolveTable(args.type)) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown type: ${args.type}` }) }] };
  }

  const row = await fetchRecord(env, args.type, args.id);
  if (!row) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `${args.type} '${args.id}' not found` }) }] };
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify(row) }] };
}
