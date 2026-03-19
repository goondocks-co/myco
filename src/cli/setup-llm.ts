import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema } from '../config/schema.js';
import { parseStringFlag } from './shared.js';

const CONFIG_FILENAME = 'myco.yaml';
const DAEMON_STATE_FILENAME = 'daemon.json';

const USAGE = `Usage: myco setup-llm [options]

Configure LLM and embedding provider settings.

Options:
  --llm-provider <name>         LLM provider (ollama, lm-studio, anthropic)
  --llm-model <name>            LLM model name
  --llm-url <url>               LLM provider base URL
  --llm-context-window <number> LLM context window (tokens)
  --llm-max-tokens <number>     LLM max output tokens
  --embedding-provider <name>   Embedding provider (ollama, lm-studio)
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
    console.log(JSON.stringify(config.intelligence, null, 2));
    return;
  }

  // No flags = show usage
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  // Ensure intelligence section exists
  if (!doc.intelligence || typeof doc.intelligence !== 'object') {
    doc.intelligence = {};
  }
  const intelligence = doc.intelligence as Record<string, unknown>;

  if (!intelligence.llm || typeof intelligence.llm !== 'object') {
    intelligence.llm = {};
  }
  if (!intelligence.embedding || typeof intelligence.embedding !== 'object') {
    intelligence.embedding = {};
  }

  const llm = intelligence.llm as Record<string, unknown>;
  const embedding = intelligence.embedding as Record<string, unknown>;

  // Parse and apply flags
  const llmProvider = parseStringFlag(args, '--llm-provider');
  if (llmProvider !== undefined) llm.provider = llmProvider;

  const llmModel = parseStringFlag(args, '--llm-model');
  if (llmModel !== undefined) llm.model = llmModel;

  const llmUrl = parseStringFlag(args, '--llm-url');
  if (llmUrl !== undefined) llm.base_url = llmUrl;

  const llmContextWindow = parseStringFlag(args, '--llm-context-window');
  if (llmContextWindow !== undefined) llm.context_window = parseInt(llmContextWindow, 10);

  const llmMaxTokens = parseStringFlag(args, '--llm-max-tokens');
  if (llmMaxTokens !== undefined) llm.max_tokens = parseInt(llmMaxTokens, 10);

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
  console.log('Intelligence configuration updated.');

  // Show what was set
  const updated = MycoConfigSchema.parse(doc);
  console.log(JSON.stringify(updated.intelligence, null, 2));

  // Warn about embedding model changes
  if (embeddingModel !== undefined) {
    console.log('\nWarning: changing the embedding model requires a full vector index rebuild.');
    console.log('Run: node dist/src/cli.js rebuild');
  }

  if (fs.existsSync(path.join(vaultDir, DAEMON_STATE_FILENAME))) {
    console.log('\nNote: restart the daemon for changes to take effect (myco restart)');
  }
}
