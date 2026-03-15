import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema, type MycoConfig } from './schema.js';

const CONFIG_FILENAME = 'myco.yaml';

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

  return MycoConfigSchema.parse(parsed);
}

export function saveConfig(vaultDir: string, config: MycoConfig): void {
  // Validate before writing — OAK lesson: validate on write, not just read
  const validated = MycoConfigSchema.parse(config);

  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(validated), 'utf-8');
}
