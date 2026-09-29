/**
 * The self-hosted target's embedding provider for the recall eval: a loopback
 * openai-compatible `/embeddings` endpoint that answers from the frozen
 * fixture. The Deployment reaches it through its real configured provider
 * (`core/embedding/configured-provider.ts`), so request shape, response
 * parsing and normalization are the shipped code's.
 *
 * A text the fixture does not hold answers 500, which the provider reports as
 * unavailable and the eval refuses to score.
 */
import type { fixtureLookup } from './lookup.ts';

export function startEmbeddingStub(lookup: ReturnType<typeof fixtureLookup>): { url: string; misses: string[]; stop(): void } {
  const misses: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/embeddings') return new Response('not found', { status: 404 });
      const body = await request.json() as { input?: unknown };
      const text = Array.isArray(body.input) && typeof body.input[0] === 'string' ? body.input[0] : null;
      if (text === null) return new Response('input must be one string', { status: 400 });
      try {
        return Response.json({ data: [{ embedding: await lookup.vectorFor(text) }] });
      } catch (error) {
        misses.push(error instanceof Error ? error.message : String(error));
        return new Response('unknown text', { status: 500 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, misses, stop: () => server.stop(true) };
}
