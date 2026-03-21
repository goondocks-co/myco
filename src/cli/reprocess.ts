/**
 * myco reprocess — re-run the observation extraction and summarization pipeline
 * for existing sessions. Useful after bugs or when the LLM backend changes.
 *
 * Reads transcripts (the source of truth), re-extracts observations, regenerates
 * summaries/titles, and re-indexes everything. Existing spore files from those
 * sessions are preserved — new observations are additive.
 *
 * Flags:
 *   --session <id>   Filter to sessions matching this substring
 *   --date <YYYY-MM-DD>  Filter to sessions from a specific date
 *   --failed         Only reprocess sessions with failed summaries
 *   --index-only     Skip all LLM calls (re-index only)
 */
import path from 'node:path';
import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { initFts } from '../index/fts.js';
import { loadConfig } from '../config/loader.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import { runReprocess } from '../services/vault-ops.js';
import { parseStringFlag } from './shared.js';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const sessionFilter = parseStringFlag(args, '--session');
  const dateFilter = parseStringFlag(args, '--date');
  const failedOnly = args.includes('--failed');
  const skipLlm = args.includes('--index-only');

  const config = loadConfig(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  initFts(index);

  const llmProvider = skipLlm ? null : createLlmProvider(config.intelligence.llm);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
  } catch (e) {
    console.log(`Vector index unavailable: ${(e as Error).message}`);
  }

  try {
    const result = await runReprocess(
      { vaultDir, config, index, vectorIndex: vectorIndex ?? undefined, log: (level, msg) => console.log(`[${level}] ${msg}`) },
      llmProvider,
      embeddingProvider,
      { session: sessionFilter, date: dateFilter, failed: failedOnly, indexOnly: skipLlm },
      (phase, done, total) => {
        process.stdout.write(`\r  ${phase}: ${done}/${total}`);
        if (done === total) process.stdout.write('\n');
      },
    );

    if (result.sessionsProcessed === 0) {
      const filters = [sessionFilter && `session="${sessionFilter}"`, dateFilter && `date="${dateFilter}"`, failedOnly && 'failed'].filter(Boolean);
      console.log(filters.length ? `No sessions matching ${filters.join(', ')} found.` : 'No sessions found.');
    } else {
      console.log(`\nDone: ${result.sessionsProcessed} sessions reprocessed, ${result.observationsExtracted} observations extracted, ${result.summariesRegenerated} summaries regenerated.`);
    }
  } finally {
    index.close();
    vectorIndex?.close();
  }
}
