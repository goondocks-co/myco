import fs from 'node:fs';
import { loadGroveConfig, updateGroveConfig } from '../config/loader.js';
import { parseStringFlag } from './shared.js';
import type { EmbeddingProviderConfig } from '../config/schema.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { resolveDaemonServiceState } from '../daemon/service-state.js';

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
  // Show current settings — embedding lives in the Grove tier
  if (args.includes('--show')) {
    const showGroveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;
    if (!showGroveId) {
      console.error('Error: project is not bound to a Grove. Open this project in any supported agent so Myco auto-registers it, then retry.');
      return;
    }
    const showGroveConfig = loadGroveConfig(showGroveId);
    console.log(JSON.stringify(showGroveConfig.embedding, null, 2));
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

  const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;
  if (!groveId) {
    console.error('Error: project is not bound to a Grove. Open this project in any supported agent so Myco auto-registers it, then retry.');
    return;
  }

  const updatedGrove = updateGroveConfig(groveId, (c) => ({
    ...c,
    embedding: { ...c.embedding, ...updates },
  }));

  console.log('Embedding configuration updated.');
  console.log(JSON.stringify(updatedGrove.embedding, null, 2));

  if (embeddingModel !== undefined) {
    console.log('\nWarning: changing the embedding model requires a full vector index rebuild.');
    console.log('Run: myco rebuild');
  }

  if (fs.existsSync(resolveDaemonServiceState(vaultDir, { env: process.env }).statePath)) {
    console.log('\nNote: restart the daemon for changes to take effect (myco restart)');
  }
}
