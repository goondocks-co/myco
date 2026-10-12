import { lit, type ParityTarget } from '../harness.ts';

/** A loopback provider for deterministic native run-lifecycle parity. */
export async function embeddingFixture(target: ParityTarget): Promise<() => void> {
  if (target.name !== 'selfhosted') return () => {};
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ embedding: [1, 0] }) });
  try {
    for (const [leaf, value] of Object.entries({ 'embedding.provider': 'ollama', 'embedding.model': 'fixture-model', 'embedding.base_url': provider.url.origin })) {
      await target.sql(`INSERT OR REPLACE INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(${lit(leaf)},${lit(JSON.stringify(value))},0,'fixture')`);
    }
    return () => provider.stop(true);
  } catch (error) { provider.stop(true); throw error; }
}
