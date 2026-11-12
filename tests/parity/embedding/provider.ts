import { type ParityTarget } from '../harness.ts';
import { owner } from '../clients/requests.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** A loopback provider for deterministic native run-lifecycle parity. */
export async function embeddingFixture(target: ParityTarget): Promise<() => void> {
  if (target.name !== 'selfhosted') return () => {};
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ embedding: [1, 0] }) });
  try {
    const response = await owner(target, '/api/embedding', { method: 'PUT', headers: await revisionHeaders(target, '/api/embedding'), body: JSON.stringify({ provider: 'ollama', model: 'fixture-model', endpoint: provider.url.origin }) });
    if (response.status !== 200) throw new Error(`embedding fixture configuration refused: ${response.status}`);
    return () => provider.stop(true);
  } catch (error) { provider.stop(true); throw error; }
}
