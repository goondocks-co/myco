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

  // Auto-map legacy 'haiku' provider name to 'anthropic'
  const intel = parsed.intelligence as Record<string, unknown> | undefined;
  const llm = intel?.llm as Record<string, unknown> | undefined;
  if (llm?.provider === 'haiku') {
    llm.provider = 'anthropic';
  }

  // Run numbered migrations
  const migrationsRan = runMigrations(parsed, vaultDir, (msg) => {
    // Log to stderr since this runs during config loading (before logger is available)
    process.stderr.write(`[myco migration] ${msg}\n`);
  });

  // Parse with Zod to fill in defaults for new config sections
  const config = MycoConfigSchema.parse(parsed);

  // Write back if migrations ran or new defaults were added
  const needsWrite = migrationsRan
    || (parsed.config_version as number ?? 0) < CURRENT_MIGRATION_VERSION
    || !('digest' in parsed);

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
