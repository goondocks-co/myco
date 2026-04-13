import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, updateConfig } from '../config/loader.js';
import { withEmbedding } from '../config/updates.js';
import { parseStringFlag } from './shared.js';
import type { EmbeddingProviderConfig } from '../config/schema.js';

const DAEMON_STATE_FILENAME = 'daemon.json';

const USAGE = `Usage: myco setup-llm [options]

Configure embedding provider settings.

In v3, LLM configuration is managed by the Myco agent (Claude Agent SDK).
Only embedding settings are user-configurable.

Options:
  --embedding-provider <name>   Embedding provider (ollama, openai-compatible)
  --embedding-model <name>      Embedding model name
  --embedding-url <url>         Embedding provider base URL
  --show                        Show current settings and exit
`;

export async function run(args: string[], vaultDir: string): Promise<void> {
  // Show current settings
  if (args.includes('--show')) {
    const config = loadConfig(vaultDir);
    console.log(JSON.stringify(config.embedding, null, 2));
    return;
  }

  // No flags = show usage
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  // Warn about removed LLM flags
  const llmProvider = parseStringFlag(args, '--llm-provider');
  const llmModel = parseStringFlag(args, '--llm-model');
  const llmUrl = parseStringFlag(args, '--llm-url');
  const llmContextWindow = parseStringFlag(args, '--llm-context-window');
  const llmMaxTokens = parseStringFlag(args, '--llm-max-tokens');
  if (llmProvider || llmModel || llmUrl || llmContextWindow || llmMaxTokens) {
    console.log('Note: LLM configuration is managed by the Myco agent. LLM flags are ignored.');
  }

  // Build partial embedding update from flags
  const updates: Partial<EmbeddingProviderConfig> = {};

  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  if (embeddingProvider !== undefined) updates.provider = embeddingProvider as EmbeddingProviderConfig['provider'];

  const embeddingModel = parseStringFlag(args, '--embedding-model');
  if (embeddingModel !== undefined) updates.model = embeddingModel;

  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  if (embeddingUrl !== undefined) updates.base_url = embeddingUrl;

  // Apply the update through the single write gate
  const updated = updateConfig(vaultDir, (config) => withEmbedding(config, updates));

  console.log('Embedding configuration updated.');
  console.log(JSON.stringify(updated.embedding, null, 2));

  if (embeddingModel !== undefined) {
    console.log('\nWarning: changing the embedding model requires a full vector index rebuild.');
    console.log('Run: myco rebuild');
  }

  if (fs.existsSync(path.join(vaultDir, DAEMON_STATE_FILENAME))) {
    console.log('\nNote: restart the daemon for changes to take effect (myco restart)');
  }
}
