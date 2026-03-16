import { loadConfig } from '../config/loader.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';

const VERIFY_LLM_PROMPT = 'Respond with OK';
const VERIFY_EMBEDDING_INPUT = 'test';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const config = loadConfig(vaultDir);
  const { llm: llmConfig, embedding: embeddingConfig } = config.intelligence;

  let llmOk = false;
  let embeddingOk = false;
  let embeddingDimensions = 0;

  // Test LLM
  try {
    const llm = createLlmProvider(llmConfig);
    const response = await llm.summarize(VERIFY_LLM_PROMPT);
    llmOk = response.text.length > 0;
  } catch (err) {
    llmOk = false;
  }

  const llmLabel = `LLM (${llmConfig.provider} / ${llmConfig.model}):`;
  console.log(`${llmLabel.padEnd(40)} ${llmOk ? 'OK' : 'FAIL'}`);

  // Test embedding
  try {
    const emb = createEmbeddingProvider(embeddingConfig);
    const response = await emb.embed(VERIFY_EMBEDDING_INPUT);
    embeddingDimensions = response.dimensions;
    embeddingOk = embeddingDimensions > 0;
  } catch (err) {
    embeddingOk = false;
  }

  const embLabel = `Embedding (${embeddingConfig.provider} / ${embeddingConfig.model}):`;
  const embStatus = embeddingOk ? `OK (${embeddingDimensions} dimensions)` : 'FAIL';
  console.log(`${embLabel.padEnd(40)} ${embStatus}`);

  if (!llmOk || !embeddingOk) {
    process.exit(1);
  }
}
