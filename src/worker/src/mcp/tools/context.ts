import type { Env } from '../../index';

export async function handleContext(args: { tier?: number }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const tier = args.tier ?? 5000;
  const row = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, tier, content, generated_at FROM digest_extracts WHERE tier = ? ORDER BY generated_at DESC LIMIT 1`,
  ).bind(tier).first<{ id: string; tier: number; content: string; generated_at: number }>();

  if (!row) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ content: null, tier, message: `No digest available at tier ${tier}` }) }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ content: row.content, tier: row.tier, generated_at: row.generated_at }) }] };
}
