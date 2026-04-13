/**
 * CLI: myco search — full-text search via direct SQLite reads.
 * CLI: myco vectors — semantic search via daemon API (requires vector store).
 *
 * The `search` command opens the database directly (WAL mode allows concurrent
 * reads) and does NOT require the daemon. The `vectors` command still routes
 * through the daemon because it needs the in-process vector store.
 */

import { CONTENT_SNIPPET_CHARS } from '@myco/constants.js';
import { fullTextSearch } from '@myco/db/queries/search.js';
import { connectToDaemon, initVaultDb } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default result limit for CLI search. */
const CLI_SEARCH_LIMIT = 10;

/** Default result limit for CLI vectors. */
const CLI_VECTORS_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  type: string;
  title: string;
  preview: string;
  score: number;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// search command — direct DB read
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco search <query>'); process.exit(1); }

  const cleanup = initVaultDb(vaultDir);
  try {
    const results = fullTextSearch(query, { limit: CLI_SEARCH_LIMIT });

    console.log(`=== Text Search: "${query}" ===`);
    if (results.length === 0) {
      console.log('  (no results)');
    } else {
      for (const r of results) {
        const preview = (r.preview ?? r.title ?? '').slice(0, CONTENT_SNIPPET_CHARS);
        console.log(`  [${r.type}] ${preview}`);
      }
    }
  } catch (err) {
    console.error('Search failed:', (err as Error).message);
    process.exit(1);
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// vectors command — requires daemon for vector store
// ---------------------------------------------------------------------------

export async function runVectors(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco vectors <query>'); process.exit(1); }

  const client = await connectToDaemon(vaultDir);

  const params = new URLSearchParams({
    q: query,
    limit: String(CLI_VECTORS_LIMIT),
    mode: 'semantic',
  });
  const result = await client.get(`/api/search?${params.toString()}`);

  if (!result.ok || !result.data?.results) {
    console.error('Semantic search failed — embedding provider may not be configured');
    process.exit(1);
  }

  const results = result.data.results as SearchResult[];

  console.log(`Query: "${query}"`);
  console.log();

  if (results.length === 0) {
    console.log('(no results)');
  } else {
    const topScore = results[0].score;
    const DEFAULT_RELATIVE_THRESHOLD = 0.5;
    console.log(`Top score: ${topScore.toFixed(4)}`);
    console.log(`Default threshold (${DEFAULT_RELATIVE_THRESHOLD}x): ${(topScore * DEFAULT_RELATIVE_THRESHOLD).toFixed(4)}`);
    console.log();
    console.log('  Sim     Ratio  Type       ID');
    console.log('  ------  -----  ---------  ' + '-'.repeat(50));
    for (const r of results) {
      const ratio = (r.score / topScore).toFixed(2);
      const pass = r.score >= topScore * DEFAULT_RELATIVE_THRESHOLD ? '\u2713' : ' ';
      const type = r.type ?? 'unknown';
      console.log(`${pass} ${r.score.toFixed(4)}  ${ratio}   ${type.padEnd(9)}  ${r.id.slice(0, 50)}`);
    }
  }
}
