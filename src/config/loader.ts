import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema, type MycoConfig } from './schema.js';
import { runMigrations, CURRENT_MIGRATION_VERSION } from './migrations.js';

export const CONFIG_FILENAME = 'myco.yaml';

export function loadConfig(vaultDir: string): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    throw new Error(`myco.yaml not found in ${vaultDir}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as Record<string, unknown>;

  // Detect v1 config and guide migration
  if (parsed.version === 1 || (parsed.intelligence as Record<string, unknown>)?.backend) {
    throw new Error(
      'Myco config uses v1 format. Run /myco:setup-llm to reconfigure for v2.',
    );
  }

  // --- v2 → v3 migration ---
  let v2Migrated = false;
  if (parsed.version === 2) {
    // Extract intelligence.embedding to top-level embedding
    const intel = parsed.intelligence as Record<string, unknown> | undefined;
    const embeddingConfig = intel?.embedding as Record<string, unknown> | undefined;
    if (embeddingConfig && !parsed.embedding) {
      // Map v2 'lm-studio' to v3 'openai-compatible' for embedding provider
      if (embeddingConfig.provider === 'lm-studio') {
        embeddingConfig.provider = 'openai-compatible';
      }
      parsed.embedding = embeddingConfig;
    }

    // Keep daemon.port and daemon.log_level, drop grace_period and max_log_size
    const daemon = parsed.daemon as Record<string, unknown> | undefined;
    if (daemon) {
      const { port, log_level } = daemon;
      parsed.daemon = { port: port ?? null, log_level: log_level ?? 'info' };
    }

    // Keep capture basics, drop token-related fields
    const capture = parsed.capture as Record<string, unknown> | undefined;
    if (capture) {
      const { transcript_paths, artifact_watch, artifact_extensions, buffer_max_events } = capture;
      parsed.capture = { transcript_paths, artifact_watch, artifact_extensions, buffer_max_events };
    }

    // Drop removed top-level sections
    delete parsed.intelligence;
    delete parsed.context;
    delete parsed.team;
    delete parsed.digest;
    delete parsed.pipeline;

    // Set version to 3
    parsed.version = 3;
    v2Migrated = true;

    process.stderr.write('[myco migration] Migrated config from v2 to v3\n');
  }

  // Run numbered migrations (for v3+ forward migrations)
  const migrationsRan = runMigrations(parsed, vaultDir, (msg) => {
    process.stderr.write(`[myco migration] ${msg}\n`);
  });

  // Parse with Zod to fill in defaults for new config sections
  const config = MycoConfigSchema.parse(parsed);

  // Write back if v2→v3 migration ran, numbered migrations ran, or new defaults were added
  const needsWrite = v2Migrated
    || migrationsRan
    || (parsed.config_version as number ?? 0) < CURRENT_MIGRATION_VERSION
    || parsed.version !== config.version;

  if (needsWrite) {
    const fullConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    fs.writeFileSync(configPath, YAML.stringify(fullConfig), 'utf-8');
  }

  return config;
}

export function saveConfig(vaultDir: string, config: MycoConfig): void {
  // Validate before writing — OAK lesson: validate on write, not just read
  const validated = MycoConfigSchema.parse(config);

  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(validated), 'utf-8');
}

export function updateConfig(
  vaultDir: string,
  fn: (config: MycoConfig) => MycoConfig,
): MycoConfig {
  const current = loadConfig(vaultDir);
  const updated = fn(current);
  saveConfig(vaultDir, updated);
  return updated;
}
