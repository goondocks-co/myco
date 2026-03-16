import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { searchFts } from '../index/fts.js';
import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import fs from 'node:fs';
import path from 'node:path';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco search <query>'); process.exit(1); }

  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  // Semantic search is primary
  const vecDb = path.join(vaultDir, 'vectors.db');
  if (fs.existsSync(vecDb)) {
    try {
      const config = loadConfig(vaultDir);
      const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
      const emb = await generateEmbedding(embeddingProvider, query);
      const vec = new VectorIndex(vecDb, emb.dimensions);

      console.log(`=== Semantic Search: "${query}" ===`);
      const results = vec.search(emb.embedding, { limit: 10 });
      if (results.length === 0) {
        console.log('  (no results)');
      } else {
        const noteMap = new Map(
          index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
        );
        for (const r of results) {
          const title = noteMap.get(r.id)?.title || r.id;
          console.log(`  sim: ${r.similarity.toFixed(3)} | [${r.metadata.type}] ${title.slice(0, 60)}`);
        }
      }
      vec.close();
    } catch (e) {
      console.log(`Semantic search unavailable: ${(e as Error).message}`);
    }
  }

  // FTS as fallback / supplementary
  console.log(`\n=== FTS Search: "${query}" ===`);
  const ftsResults = searchFts(index, query, { limit: 10 });
  if (ftsResults.length === 0) {
    console.log('  (no results)');
  } else {
    for (const r of ftsResults) {
      console.log(`  [${r.type}] ${r.title?.slice(0, 70)}`);
      if (r.snippet) console.log(`    ${r.snippet.slice(0, 100)}`);
    }
  }

  index.close();
}

export async function runVectors(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco vectors <query>'); process.exit(1); }

  const config = loadConfig(vaultDir);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
  const emb = await generateEmbedding(embeddingProvider, query);

  const vecDb = path.join(vaultDir, 'vectors.db');
  if (!fs.existsSync(vecDb)) { console.error('No vector index found'); process.exit(1); }

  const vec = new VectorIndex(vecDb, emb.dimensions);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  // Show all results with no threshold filtering for tuning
  const results = vec.search(emb.embedding, { limit: 20, relativeThreshold: 0 });

  console.log(`Query: "${query}"`);
  console.log(`Dimensions: ${emb.dimensions}`);
  console.log(`Total vectors: ${vec.count()}`);
  console.log();

  if (results.length === 0) {
    console.log('(no results)');
  } else {
    const noteMap = new Map(
      index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
    );
    const topScore = results[0].similarity;
    console.log(`Top score: ${topScore.toFixed(4)}`);
    console.log(`Default threshold (0.5x): ${(topScore * 0.5).toFixed(4)}`);
    console.log();
    console.log('  Sim     Ratio  Type       ID / Title');
    console.log('  ------  -----  ---------  ' + '-'.repeat(50));
    for (const r of results) {
      const title = noteMap.get(r.id)?.title || r.id;
      const ratio = (r.similarity / topScore).toFixed(2);
      const pass = r.similarity >= topScore * 0.5 ? '\u2713' : ' ';
      console.log(`${pass} ${r.similarity.toFixed(4)}  ${ratio}   ${r.metadata.type.padEnd(9)}  ${title.slice(0, 50)}`);
    }
  }

  vec.close();
  index.close();
}
