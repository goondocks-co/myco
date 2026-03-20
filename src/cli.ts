#!/usr/bin/env node
import { loadEnv } from './cli/shared.js';
import { resolveVaultDir } from './vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();

const USAGE = `Usage: myco <command> [args]

Commands:
  init [options]           Initialize a new vault
  config <get|set> [args]  Get or set vault config values
  detect-providers         Detect available LLM/embedding providers (JSON)
  verify                   Test LLM and embedding connectivity
  stats                    Vault health, index counts, vector count
  search <query>           Combined FTS + vector search with scores
  vectors <query>          Raw vector search with similarity scores
  session [id|latest]      Show a session note
  logs [options]           View daemon logs
  setup-llm [options]      Configure LLM and embedding providers
  setup-digest [options]   Configure digest and capture settings
  digest [options]         Run a digest cycle (--tier N, --full)
  restart                  Restart the daemon
  rebuild                  Reindex the entire vault
  reprocess [options]      Re-extract observations, regenerate summaries, re-index
  version                  Show plugin version
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'init') return (await import('./cli/init.js')).run(args);
  if (cmd === 'detect-providers') return (await import('./cli/detect-providers.js')).run(args);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const { getPluginVersion } = await import('./version.js');
    console.log(getPluginVersion());
    return;
  }

  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
    process.exit(1);
  }

  switch (cmd) {
    case 'config': return (await import('./cli/config.js')).run(args, vaultDir);
    case 'verify': return (await import('./cli/verify.js')).run(args, vaultDir);
    case 'stats': return (await import('./cli/stats.js')).run(args, vaultDir);
    case 'search': return (await import('./cli/search.js')).run(args, vaultDir);
    case 'vectors': return (await import('./cli/search.js')).runVectors(args, vaultDir);
    case 'session': return (await import('./cli/session.js')).run(args, vaultDir);
    case 'setup-llm': return (await import('./cli/setup-llm.js')).run(args, vaultDir);
    case 'setup-digest': return (await import('./cli/setup-digest.js')).run(args, vaultDir);
    case 'digest': return (await import('./cli/digest.js')).run(args, vaultDir);
    case 'restart': return (await import('./cli/restart.js')).run(args, vaultDir);
    case 'rebuild': return (await import('./cli/rebuild.js')).run(args, vaultDir);
    case 'reprocess': return (await import('./cli/reprocess.js')).run(args, vaultDir);
    case 'logs': return (await import('./cli/logs.js')).run(args, vaultDir);
    default:
      console.error(`Unknown command: ${cmd}`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exit(1);
});
