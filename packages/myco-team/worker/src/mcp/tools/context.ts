import type { Env } from '../../index';
import { textJson } from '../result-shape';

const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';

export async function handleContext(args: { tier?: number }, env: Pick<Env, 'MYCO_TEAM_DB'>) {
  const tier = args.tier ?? 5000;
  const row = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, tier, content, generated_at FROM digest_extracts WHERE tier = ? ORDER BY generated_at DESC LIMIT 1`,
  ).bind(tier).first<{ id: string; tier: number; content: string; generated_at: number }>();

  if (!row) {
    return textJson({ content: NO_DIGEST_MESSAGE, tier, fallback: false });
  }
  return textJson({ content: row.content, tier: row.tier, fallback: false, generated_at: row.generated_at });
}
