/**
 * CLI: myco search — semantic search via pgvector.
 *
 * Embeds the query text and searches the spores and sessions tables.
 * Falls back to a simple SQL LIKE search when no embedding provider is available.
 */

import { initDatabaseForVault, getDatabase } from '@myco/db/client.js';
import { searchSimilar } from '@myco/db/queries/embeddings.js';
import { loadConfig } from '@myco/config/loader.js';
import { createEmbeddingProvider } from '@myco/intelligence/llm.js';
import { generateEmbedding } from '@myco/intelligence/embeddings.js';
import { CONTENT_SNIPPET_CHARS } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default result limit for CLI search. */
const CLI_SEARCH_LIMIT = 10;

/** Default result limit for CLI vectors. */
const CLI_VECTORS_LIMIT = 20;

/** Minimum relative threshold for vectors display (show all). */
const VECTORS_NO_THRESHOLD = 0;

/** Relative threshold for default search filtering (50% of top score). */
const DEFAULT_RELATIVE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// search command
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco search <query>'); process.exit(1); }

  const db = await initDatabaseForVault(vaultDir);

  const config = loadConfig(vaultDir);

  // Semantic search is primary
  try {
    const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
    const emb = await generateEmbedding(embeddingProvider, query);

    console.log(`=== Semantic Search: "${query}" ===`);

    for (const table of ['spores', 'sessions'] as const) {
      const results = await searchSimilar(table, emb.embedding, { limit: CLI_SEARCH_LIMIT });
      if (results.length === 0) continue;

      console.log(`\n--- ${table} ---`);
      for (const r of results) {
        const content = ((r.content as string) ?? (r.summary as string) ?? '').slice(0, CONTENT_SNIPPET_CHARS);
        const type = table === 'spores' ? (r.observation_type as string) : 'session';
        console.log(`  sim: ${r.similarity.toFixed(3)} | [${type}] ${content}`);
      }
    }
  } catch (e) {
    console.log(`Semantic search unavailable: ${(e as Error).message}`);
  }

  // FTS-like fallback via SQL LIKE
  console.log(`\n=== Text Search: "${query}" ===`);
  const likePattern = `%${query}%`;

  const sporeResults = await db.query(
    `SELECT id, observation_type, content FROM spores
     WHERE content ILIKE $1 OR observation_type ILIKE $1
     ORDER BY created_at DESC LIMIT $2`,
    [likePattern, CLI_SEARCH_LIMIT],
  );

  const sessionResults = await db.query(
    `SELECT id, title, summary FROM sessions
     WHERE title ILIKE $1 OR summary ILIKE $1
     ORDER BY created_at DESC LIMIT $2`,
    [likePattern, CLI_SEARCH_LIMIT],
  );

  if (sporeResults.rows.length === 0 && sessionResults.rows.length === 0) {
    console.log('  (no results)');
  } else {
    for (const row of sporeResults.rows as Record<string, unknown>[]) {
      console.log(`  [${row.observation_type}] ${(row.content as string).slice(0, CONTENT_SNIPPET_CHARS)}`);
    }
    for (const row of sessionResults.rows as Record<string, unknown>[]) {
      const title = (row.title as string) ?? row.id;
      console.log(`  [session] ${(title as string).slice(0, CONTENT_SNIPPET_CHARS)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// vectors command
// ---------------------------------------------------------------------------

export async function runVectors(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco vectors <query>'); process.exit(1); }

  await initDatabaseForVault(vaultDir);

  const config = loadConfig(vaultDir);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
  const emb = await generateEmbedding(embeddingProvider, query);

  // Count total embeddings
  const dbConn = getDatabase();
  const sporeCount = await dbConn.query('SELECT COUNT(*) AS cnt FROM spores WHERE embedding IS NOT NULL');
  const sessionCount = await dbConn.query('SELECT COUNT(*) AS cnt FROM sessions WHERE embedding IS NOT NULL');
  const totalVectors = ((sporeCount.rows[0] as Record<string, unknown>).cnt as number)
    + ((sessionCount.rows[0] as Record<string, unknown>).cnt as number);

  console.log(`Query: "${query}"`);
  console.log(`Dimensions: ${emb.dimensions}`);
  console.log(`Total vectors: ${totalVectors}`);
  console.log();

  // Search spores with no threshold filtering for tuning
  const results = await searchSimilar('spores', emb.embedding, { limit: CLI_VECTORS_LIMIT });

  if (results.length === 0) {
    console.log('(no results)');
  } else {
    const topScore = results[0].similarity;
    console.log(`Top score: ${topScore.toFixed(4)}`);
    console.log(`Default threshold (${DEFAULT_RELATIVE_THRESHOLD}x): ${(topScore * DEFAULT_RELATIVE_THRESHOLD).toFixed(4)}`);
    console.log();
    console.log('  Sim     Ratio  Type       ID');
    console.log('  ------  -----  ---------  ' + '-'.repeat(50));
    for (const r of results) {
      const ratio = (r.similarity / topScore).toFixed(2);
      const pass = r.similarity >= topScore * DEFAULT_RELATIVE_THRESHOLD ? '\u2713' : ' ';
      const type = (r.observation_type as string) ?? 'unknown';
      console.log(`${pass} ${r.similarity.toFixed(4)}  ${ratio}   ${type.padEnd(9)}  ${(r.id as string).slice(0, 50)}`);
    }
  }
}
