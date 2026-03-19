import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema } from '../config/schema.js';
import { parseStringFlag } from './shared.js';

const CONFIG_FILENAME = 'myco.yaml';
const DAEMON_STATE_FILENAME = 'daemon.json';

const USAGE = `Usage: myco setup-digest [options]

Configure digest (continuous reasoning) settings.

Options:
  --enabled <true|false>        Enable/disable digest (default: true)
  --tiers <1500,3000,...>       Comma-separated tier list
  --inject-tier <number|null>   Tier to auto-inject at session start
  --provider <name>             LLM provider for digest (null = inherit)
  --model <name>                Model for digest (null = inherit)
  --base-url <url>              Provider base URL (null = inherit)
  --context-window <number>     Context window for digest operations
  --keep-alive <duration>       Keep model loaded (Ollama, e.g. "30m")
  --gpu-kv-cache <true|false>   Offload KV cache to GPU (LM Studio)
  --active-interval <seconds>   Metabolism active interval
  --dormancy-threshold <seconds> Time before dormancy
  --max-notes <number>          Max substrate notes per cycle
  --extraction-tokens <number>  Max tokens for spore extraction
  --summary-tokens <number>     Max tokens for session summaries
  --title-tokens <number>       Max tokens for session titles
  --classification-tokens <number> Max tokens for artifact classification
  --show                        Show current settings and exit
`;

export async function run(args: string[], vaultDir: string): Promise<void> {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const raw = fs.readFileSync(configPath, 'utf-8');
  const doc = YAML.parse(raw) as Record<string, unknown>;

  // Show current settings
  if (args.includes('--show')) {
    const config = MycoConfigSchema.parse(doc);
    console.log(JSON.stringify({
      digest: config.digest,
      capture: {
        extraction_max_tokens: config.capture.extraction_max_tokens,
        summary_max_tokens: config.capture.summary_max_tokens,
        title_max_tokens: config.capture.title_max_tokens,
        classification_max_tokens: config.capture.classification_max_tokens,
      },
    }, null, 2));
    return;
  }

  // No flags = show usage
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  // Ensure digest section exists
  if (!doc.digest || typeof doc.digest !== 'object') {
    doc.digest = {};
  }
  const digest = doc.digest as Record<string, unknown>;

  // Ensure nested sections exist
  if (!digest.intelligence || typeof digest.intelligence !== 'object') {
    digest.intelligence = {};
  }
  if (!digest.metabolism || typeof digest.metabolism !== 'object') {
    digest.metabolism = {};
  }
  if (!digest.substrate || typeof digest.substrate !== 'object') {
    digest.substrate = {};
  }
  if (!doc.capture || typeof doc.capture !== 'object') {
    doc.capture = {};
  }

  const intelligence = digest.intelligence as Record<string, unknown>;
  const metabolism = digest.metabolism as Record<string, unknown>;
  const substrate = digest.substrate as Record<string, unknown>;
  const capture = doc.capture as Record<string, unknown>;

  // Parse and apply flags
  const enabled = parseStringFlag(args, '--enabled');
  if (enabled !== undefined) digest.enabled = enabled === 'true';

  const tiers = parseStringFlag(args, '--tiers');
  if (tiers !== undefined) {
    digest.tiers = tiers.split(',').map((t) => parseInt(t.trim(), 10));
  }

  const injectTier = parseStringFlag(args, '--inject-tier');
  if (injectTier !== undefined) {
    digest.inject_tier = injectTier === 'null' ? null : parseInt(injectTier, 10);
  }

  const provider = parseStringFlag(args, '--provider');
  if (provider !== undefined) intelligence.provider = provider === 'null' ? null : provider;

  const model = parseStringFlag(args, '--model');
  if (model !== undefined) intelligence.model = model === 'null' ? null : model;

  const baseUrl = parseStringFlag(args, '--base-url');
  if (baseUrl !== undefined) intelligence.base_url = baseUrl === 'null' ? null : baseUrl;

  const contextWindow = parseStringFlag(args, '--context-window');
  if (contextWindow !== undefined) intelligence.context_window = parseInt(contextWindow, 10);

  const keepAlive = parseStringFlag(args, '--keep-alive');
  if (keepAlive !== undefined) intelligence.keep_alive = keepAlive === 'null' ? null : keepAlive;

  const gpuKvCache = parseStringFlag(args, '--gpu-kv-cache');
  if (gpuKvCache !== undefined) intelligence.gpu_kv_cache = gpuKvCache === 'true';

  const activeInterval = parseStringFlag(args, '--active-interval');
  if (activeInterval !== undefined) metabolism.active_interval = parseInt(activeInterval, 10);

  const dormancyThreshold = parseStringFlag(args, '--dormancy-threshold');
  if (dormancyThreshold !== undefined) metabolism.dormancy_threshold = parseInt(dormancyThreshold, 10);

  const maxNotes = parseStringFlag(args, '--max-notes');
  if (maxNotes !== undefined) substrate.max_notes_per_cycle = parseInt(maxNotes, 10);

  const extractionTokens = parseStringFlag(args, '--extraction-tokens');
  if (extractionTokens !== undefined) capture.extraction_max_tokens = parseInt(extractionTokens, 10);

  const summaryTokens = parseStringFlag(args, '--summary-tokens');
  if (summaryTokens !== undefined) capture.summary_max_tokens = parseInt(summaryTokens, 10);

  const titleTokens = parseStringFlag(args, '--title-tokens');
  if (titleTokens !== undefined) capture.title_max_tokens = parseInt(titleTokens, 10);

  const classificationTokens = parseStringFlag(args, '--classification-tokens');
  if (classificationTokens !== undefined) capture.classification_max_tokens = parseInt(classificationTokens, 10);

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
  console.log('Digest configuration updated.');

  // Show what was set
  const updated = MycoConfigSchema.parse(doc);
  console.log(JSON.stringify({
    digest: updated.digest,
    capture: {
      extraction_max_tokens: updated.capture.extraction_max_tokens,
      summary_max_tokens: updated.capture.summary_max_tokens,
      title_max_tokens: updated.capture.title_max_tokens,
      classification_max_tokens: updated.capture.classification_max_tokens,
    },
  }, null, 2));

  if (fs.existsSync(path.join(vaultDir, DAEMON_STATE_FILENAME))) {
    console.log('\nNote: restart the daemon for changes to take effect (myco restart)');
  }
}
