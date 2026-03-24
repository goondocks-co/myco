import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema } from '../config/schema.js';
import { parseStringFlag } from './shared.js';

const CONFIG_FILENAME = 'myco.yaml';
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
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const raw = fs.readFileSync(configPath, 'utf-8');
  const doc = YAML.parse(raw) as Record<string, unknown>;

  // Show current settings
  if (args.includes('--show')) {
    const config = MycoConfigSchema.parse(doc);
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

  // Ensure embedding section exists
  if (!doc.embedding || typeof doc.embedding !== 'object') {
    doc.embedding = {};
  }
  const embedding = doc.embedding as Record<string, unknown>;

  // Parse and apply embedding flags
  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  if (embeddingProvider !== undefined) embedding.provider = embeddingProvider;

  const embeddingModel = parseStringFlag(args, '--embedding-model');
  if (embeddingModel !== undefined) embedding.model = embeddingModel;

  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  if (embeddingUrl !== undefined) embedding.base_url = embeddingUrl;

  // Validate the full config
  const result = MycoConfigSchema.safeParse(doc);
  if (!result.success) {
    console.error('Validation error:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  // Write back
  fs.writeFileSync(configPath, YAML.stringify(doc), 'utf-8');
  console.log('Embedding configuration updated.');

  // Show what was set
  const updated = MycoConfigSchema.parse(doc);
  console.log(JSON.stringify(updated.embedding, null, 2));

  // Warn about embedding model changes
  if (embeddingModel !== undefined) {
    console.log('\nWarning: changing the embedding model requires a full vector index rebuild.');
    console.log('Run: myco rebuild');
  }

  if (fs.existsSync(path.join(vaultDir, DAEMON_STATE_FILENAME))) {
    console.log('\nNote: restart the daemon for changes to take effect (myco restart)');
  }
}
