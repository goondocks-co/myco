/**
 * A deterministic embedding for parity fixtures: each word counts toward one of `dimensions` slots, so texts that share
 * words lie close and texts that share none lie apart, which semantic recall's calibration needs to separate a match.
 */
export function wordVector(text: string, dimensions: number): number[] {
  const values: number[] = Array.from({ length: dimensions }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    values[hash % dimensions] = values[hash % dimensions]! + 1;
  }
  if (!values.some((value) => value > 0)) values[0] = 1;
  return values;
}

/** A loopback Ollama endpoint answering `wordVector` embeddings, for the native target, and how to stop it. */
export function wordVectorProvider(dimensions = 64): { origin: string; stop(): void } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    const body = await request.json() as { input?: string[] };
    return Response.json({ embeddings: (body.input ?? []).map((text) => wordVector(text, dimensions)) });
  } });
  return { origin: server.url.origin, stop: () => { void server.stop(true); } };
}
