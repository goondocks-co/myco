/**
 * myco curate — scan the vault for stale spores and supersede them.
 *
 * Usage:
 *   myco curate              Scan and supersede stale spores
 *   myco curate --dry-run    Show what would be superseded without writing
 *
 * Algorithm:
 *   1. Load all active spores from the index
 *   2. Group by observation_type
 *   3. Within each group, embed spores and cluster by cosine similarity
 *   4. For each cluster with 2+ members, ask the LLM which are outdated
 *   5. Mark superseded: update frontmatter, append notice, re-index, remove vector
 */
import path from 'node:path';
import { loadConfig } from '../config/loader.js';
import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import { runCuration } from '../services/vault-ops.js';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const isDryRun = args.includes('--dry-run');

  const config = loadConfig(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  const llmProvider = createLlmProvider(config.intelligence.llm);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
  } catch (e) {
    console.error(`Vector index unavailable: ${(e as Error).message}`);
    console.error('Curate requires a working embedding provider.');
    index.close();
    process.exit(1);
  }

  try {
    if (isDryRun) {
      console.log('Dry run — no changes will be written.\n');
    }

    const result = await runCuration(
      {
        vaultDir,
        config,
        index,
        vectorIndex,
        llmProvider,
        embeddingProvider,
        log: (_level, message) => console.log(`  ${message}`),
      },
      isDryRun,
    );

    console.log(`\nCuration complete:`);
    console.log(`  Scanned: ${result.scanned} active spores`);
    console.log(`  Clusters evaluated: ${result.clustersEvaluated}`);
    if (isDryRun) {
      console.log(`  Would supersede: ${result.superseded}`);
    } else {
      console.log(`  Superseded: ${result.superseded}`);
    }
  } finally {
    index.close();
    vectorIndex?.close();
  }
}
