import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../config/loader.js';
import { MycoConfigSchema } from '../config/schema.js';

const CONFIG_FILENAME = 'myco.yaml';
const DAEMON_STATE_FILENAME = 'daemon.json';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const [subcommand, key, ...rest] = args;

  if (subcommand === 'get') {
    if (!key) {
      console.error('Usage: myco config get <dot.path.key>');
      process.exit(1);
    }
    return configGet(key, vaultDir);
  }

  if (subcommand === 'set') {
    const value = rest[0];
    if (!key || value === undefined) {
      console.error('Usage: myco config set <dot.path.key> <value>');
      process.exit(1);
    }
    return configSet(key, value, vaultDir);
  }

  console.error('Usage: myco config <get|set> <dot.path.key> [value]');
  process.exit(1);
}

function configGet(dotPath: string, vaultDir: string): void {
  const config = loadConfig(vaultDir);
  const value = walkPath(config as Record<string, unknown>, dotPath);
  if (value === undefined) {
    console.error(`Key not found: ${dotPath}`);
    process.exit(1);
  }
  console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
}

function configSet(dotPath: string, rawValue: string, vaultDir: string): void {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const raw = fs.readFileSync(configPath, 'utf-8');
  const doc = YAML.parse(raw) as Record<string, unknown>;

  const value = parseValue(rawValue);
  setPath(doc, dotPath, value);

  const result = MycoConfigSchema.safeParse(doc);
  if (!result.success) {
    console.error('Validation error:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  fs.writeFileSync(configPath, YAML.stringify(doc), 'utf-8');
  console.log(`Set ${dotPath} = ${JSON.stringify(value)}`);

  if (fs.existsSync(path.join(vaultDir, DAEMON_STATE_FILENAME))) {
    console.log('Note: restart the daemon for changes to take effect (myco restart)');
  }
}

/** Walk a dot-separated path to retrieve a nested value. */
function walkPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const segments = dotPath.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Set a value at a dot-separated path, creating intermediate objects as needed. */
function setPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

/** Parse a string value as JSON (number, boolean, array, object), falling back to raw string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
