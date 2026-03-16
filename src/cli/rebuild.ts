import { EMBEDDING_INPUT_LIMIT } from '../constants.js';
import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { rebuildIndex } from '../index/rebuild.js';
import { initFts } from '../index/fts.js';
import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { batchExecute, EMBEDDING_BATCH_CONCURRENCY } from '../intelligence/batch.js';
import fs from 'node:fs';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  console.log(`Rebuilding index for ${vaultDir}...`);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  initFts(index);
  const count = rebuildIndex(index, vaultDir);
  console.log(`Indexed ${count} notes (FTS)`);

  // Rebuild vector embeddings for all notes
  const vecDb = path.join(vaultDir, 'vectors.db');
  try {
    const config = loadConfig(vaultDir);
    const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
    const testEmbed = await embeddingProvider.embed('test');
    const vec = new VectorIndex(vecDb, testEmbed.dimensions);

    const allNotes = index.query({});
    // Skip superseded/archived memories — they shouldn't appear in vector search
    const activeNotes = allNotes.filter((n) => {
      const status = (n.frontmatter as Record<string, unknown>)?.status as string | undefined;
      return status !== 'superseded' && status !== 'archived';
    });

    console.log(`Embedding ${activeNotes.length} notes (concurrency: ${EMBEDDING_BATCH_CONCURRENCY})...`);

    const result = await batchExecute(
      activeNotes,
      async (note) => {
        const text = `${note.title}\n${note.content}`.slice(0, EMBEDDING_INPUT_LIMIT);
        const emb = await generateEmbedding(embeddingProvider, text);
        vec.upsert(note.id, emb.embedding, {
          type: note.type,
          session_id: (note.frontmatter as Record<string, unknown>)?.session as string ?? '',
        });
      },
      {
        concurrency: EMBEDDING_BATCH_CONCURRENCY,
        onProgress: (done, total) => process.stdout.write(`\rEmbedded ${done}/${total}`),
      },
    );

    console.log(`\nEmbedded ${result.succeeded} notes (vectors)`);
    if (result.failed > 0) {
      console.log(`Failed: ${result.failed}`);
    }
    console.log(`Skipped ${allNotes.length - activeNotes.length} superseded/archived`);
    vec.close();
  } catch (e) {
    console.log(`Vector rebuild skipped: ${(e as Error).message}`);
  }

  index.close();
}
