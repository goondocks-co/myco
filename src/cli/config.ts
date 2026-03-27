import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, updateConfig } from '../config/loader.js';
import { withValue } from '../config/updates.js';

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
  const value = parseValue(rawValue);

  try {
    updateConfig(vaultDir, (config) => withValue(config, dotPath, value));
  } catch (err) {
    if (err instanceof Error && 'issues' in err) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
      console.error('Validation error:');
      for (const issue of issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw err;
  }

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

/** Parse a string value as JSON (number, boolean, array, object), falling back to raw string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
