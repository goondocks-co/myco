import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';

const VERIFY_EMBEDDING_INPUT = 'test';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const config = loadConfig(vaultDir);
  const embeddingConfig = config.embedding;

  let embeddingOk = false;
  let embeddingDimensions = 0;

  // Test embedding
  try {
    const emb = createEmbeddingProvider(embeddingConfig);
    const response = await emb.embed(VERIFY_EMBEDDING_INPUT);
    embeddingDimensions = response.dimensions;
    embeddingOk = embeddingDimensions > 0;
  } catch {
    embeddingOk = false;
  }

  const embLabel = `Embedding (${embeddingConfig.provider} / ${embeddingConfig.model}):`;
  const embStatus = embeddingOk ? `OK (${embeddingDimensions} dimensions)` : 'FAIL';
  console.log(`${embLabel.padEnd(40)} ${embStatus}`);

  console.log('\nNote: LLM configuration is managed by the Myco agent (Claude Agent SDK).');

  if (!embeddingOk) {
    process.exit(1);
  }
}
