import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import { runRebuild } from '../services/vault-ops.js';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  console.log(`Rebuilding index for ${vaultDir}...`);
  const config = loadConfig(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  let vectorIndex: VectorIndex | undefined;
  let embeddingProvider;
  try {
    embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
  } catch (e) {
    console.log(`Vector rebuild skipped: ${(e as Error).message}`);
  }

  try {
    const result = await runRebuild(
      { vaultDir, config, index, vectorIndex },
      embeddingProvider!,
      (done, total) => process.stdout.write(`\rEmbedded ${done}/${total}`),
    );

    console.log(`Indexed ${result.ftsCount} notes (FTS)`);
    if (vectorIndex) {
      console.log(`\nEmbedded ${result.embeddedCount} notes (vectors)`);
      if (result.failedCount > 0) {
        console.log(`Failed: ${result.failedCount}`);
      }
      console.log(`Skipped ${result.skippedCount} superseded/archived`);
    }
  } finally {
    vectorIndex?.close();
    index.close();
  }
}
