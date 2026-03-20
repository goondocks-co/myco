/**
 * myco digest — run a digest cycle from the CLI.
 *
 * Usage:
 *   myco digest              Incremental cycle (only new substrate)
 *   myco digest --full       Full reprocess of all tiers from clean slate
 *   myco digest --tier 3000  Reprocess a specific tier from clean slate
 *
 * When --tier or --full is used, the cycle processes ALL vault notes (not just
 * new ones) and ignores previous extracts, producing a clean synthesis.
 */
import { loadConfig } from '../config/loader.js';
import { MycoIndex } from '../index/sqlite.js';
import { createLlmProvider } from '../intelligence/llm.js';
import { DigestEngine } from '../daemon/digest.js';
import type { DigestCycleOptions } from '../daemon/digest.js';
import { parseIntFlag } from './shared.js';
import path from 'node:path';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const config = loadConfig(vaultDir);

  if (!config.digest.enabled) {
    console.error('Digest is not enabled. Set digest.enabled: true in myco.yaml.');
    process.exit(1);
  }

  const tierArg = parseIntFlag(args, '--tier');
  const isFull = args.includes('--full');
  const isReprocess = isFull || tierArg !== undefined;

  // Resolve the digest LLM provider
  const digestLlmConfig = {
    provider: config.digest.intelligence.provider ?? config.intelligence.llm.provider,
    model: config.digest.intelligence.model ?? config.intelligence.llm.model,
    base_url: config.digest.intelligence.base_url ?? config.intelligence.llm.base_url,
    context_window: config.digest.intelligence.context_window,
  };
  const llmProvider = createLlmProvider(digestLlmConfig);

  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  const engine = new DigestEngine({
    vaultDir,
    index,
    llmProvider,
    config,
    log: (level, message, data) => {
      const prefix = level === 'warn' ? '⚠' : level === 'info' ? '→' : '  ';
      const suffix = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`${prefix} ${message}${suffix}`);
    },
  });

  const opts: DigestCycleOptions = {};
  if (isReprocess) {
    opts.fullReprocess = true;
    opts.cleanSlate = true;
  }
  if (tierArg !== undefined) {
    const eligible = engine.getEligibleTiers();
    if (!eligible.includes(tierArg)) {
      console.error(`Tier ${tierArg} is not eligible. Eligible tiers: [${eligible.join(', ')}]`);
      index.close();
      process.exit(1);
    }
    opts.tiers = [tierArg];
  }

  if (isReprocess) {
    const tierLabel = tierArg ? `tier ${tierArg}` : 'all tiers';
    console.log(`Full reprocess of ${tierLabel} — clean slate, all substrate`);
  } else {
    console.log('Running incremental digest cycle');
  }

  try {
    const result = await engine.runCycle(opts);

    if (!result) {
      console.log('No substrate found — nothing to digest.');
      return;
    }

    console.log(`\nDigest cycle complete:`);
    console.log(`  Tiers generated: [${result.tiersGenerated.join(', ')}]`);
    console.log(`  Substrate: ${Object.values(result.substrate).flat().length} notes`);
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Model: ${result.model}`);
  } finally {
    index.close();
  }
}
