import type { LlmBackend, EmbeddingResponse } from './llm.js';

export async function generateEmbedding(
  backend: LlmBackend,
  text: string,
): Promise<EmbeddingResponse> {
  const raw = await backend.embed(text);
  return {
    embedding: normalize(raw.embedding),
    model: raw.model,
    dimensions: raw.dimensions,
  };
}

function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}
