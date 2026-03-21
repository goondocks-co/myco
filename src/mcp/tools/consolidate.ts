import { consolidateSpores } from '../../vault/consolidation.js';
import type { MycoIndex } from '../../index/sqlite.js';
import type { VectorIndex } from '../../index/vectors.js';
import type { EmbeddingProvider } from '../../intelligence/llm.js';

interface ConsolidateToolInput {
  source_spore_ids: string[];
  consolidated_content: string;
  observation_type: string;
  tags?: string[];
}

export async function handleMycoConsolidate(
  vaultDir: string,
  index: MycoIndex,
  input: ConsolidateToolInput,
  vectorIndex: VectorIndex | null = null,
  embeddingProvider: EmbeddingProvider | null = null,
) {
  return consolidateSpores(
    {
      sourceSporeIds: input.source_spore_ids,
      consolidatedContent: input.consolidated_content,
      observationType: input.observation_type,
      tags: input.tags,
    },
    { vaultDir, index, vectorIndex, embeddingProvider },
  );
}
