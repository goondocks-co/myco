/**
 * CLI: myco search / myco vectors — search via daemon API.
 *
 * Routes through the daemon HTTP API to avoid PGlite file lock conflicts.
 * The daemon handles embedding, semantic search, and FTS internally.
 */

import { DaemonClient } from '../hooks/client.js';
import { CONTENT_SNIPPET_CHARS } from '@myco/constants.js';

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
// search command
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco search <query>'); process.exit(1); }

  const client = new DaemonClient(vaultDir);
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Failed to connect to daemon');
    process.exit(1);
  }

  // Semantic search
  const semanticParams = new URLSearchParams({
    q: query,
    limit: String(CLI_SEARCH_LIMIT),
    mode: 'semantic',
  });
  const semanticResult = await client.get(`/api/search?${semanticParams.toString()}`);

  if (semanticResult.ok && semanticResult.data?.results) {
    const results = semanticResult.data.results as SearchResult[];
    console.log(`=== Semantic Search: "${query}" ===`);
    if (results.length === 0) {
      if (semanticResult.data.error === 'embedding_unavailable') {
        console.log('  Semantic search unavailable: embedding provider not configured');
      } else {
        console.log('  (no results)');
      }
    } else {
      for (const r of results) {
        const preview = (r.preview ?? r.title ?? '').slice(0, CONTENT_SNIPPET_CHARS);
        console.log(`  sim: ${r.score.toFixed(3)} | [${r.type}] ${preview}`);
      }
    }
  }

  // FTS fallback
  const ftsParams = new URLSearchParams({
    q: query,
    limit: String(CLI_SEARCH_LIMIT),
    mode: 'fts',
  });
  const ftsResult = await client.get(`/api/search?${ftsParams.toString()}`);

  console.log(`\n=== Text Search: "${query}" ===`);
  if (ftsResult.ok && ftsResult.data?.results) {
    const results = ftsResult.data.results as SearchResult[];
    if (results.length === 0) {
      console.log('  (no results)');
    } else {
      for (const r of results) {
        const preview = (r.preview ?? r.title ?? '').slice(0, CONTENT_SNIPPET_CHARS);
        console.log(`  [${r.type}] ${preview}`);
      }
    }
  } else {
    console.log('  (no results)');
  }
}

// ---------------------------------------------------------------------------
// vectors command
// ---------------------------------------------------------------------------

export async function runVectors(args: string[], vaultDir: string): Promise<void> {
  const query = args.join(' ');
  if (!query) { console.error('Usage: myco vectors <query>'); process.exit(1); }

  const client = new DaemonClient(vaultDir);
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Failed to connect to daemon');
    process.exit(1);
  }

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
