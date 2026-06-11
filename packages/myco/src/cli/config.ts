import fs from 'node:fs';
import {
  loadConfig,
  updateConfig,
  updateTierConfigRaw,
  TierConfigUnreadableError,
} from '../config/loader.js';
import { scopePolicyForPath, type ScopeEntry } from '../config/scope.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { withValue } from '../config/updates.js';
import { getAtPath, setAtPath } from '../utils/dot-path.js';
import { resolveDaemonServiceState } from '../daemon/service-state.js';

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
  const value = getAtPath(config as Record<string, unknown>, dotPath);
  if (value === undefined) {
    console.error(`Key not found: ${dotPath}`);
    process.exit(1);
  }
  console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
}

function configSet(dotPath: string, rawValue: string, vaultDir: string): void {
  const value = parseValue(rawValue);

  // Scope-aware dispatch: write the value into the tier file that owns the
  // path so it actually takes effect (a wrong-tier write is pruned at merge
  // time and silently vanishes).
  let policy: ScopeEntry;
  try {
    policy = scopePolicyForPath(dotPath);
  } catch {
    console.error(`Unknown config setting: ${dotPath}`);
    process.exit(1);
    return;
  }

  try {
    if (policy.home === 'machine') {
      updateTierConfigRaw({ kind: 'machine' }, (rawDoc) => {
        setAtPath(rawDoc, dotPath, value);
        return rawDoc;
      });
    } else if (policy.home === 'grove') {
      const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;
      if (groveId) {
        updateTierConfigRaw({ kind: 'grove', groveId }, (rawDoc) => {
          setAtPath(rawDoc, dotPath, value);
          return rawDoc;
        });
      } else {
        // Unbound project: myco.yaml retains grove-tier values until a
        // Grove binds, then the loader lifts them into grove config.
        updateConfig(vaultDir, (config) => withValue(config, dotPath, value));
      }
    } else {
      updateConfig(vaultDir, (config) => withValue(config, dotPath, value));
    }
  } catch (err) {
    if (err instanceof TierConfigUnreadableError) {
      console.error(err.message);
      process.exit(1);
    }
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

  if (fs.existsSync(resolveDaemonServiceState(vaultDir, { env: process.env }).statePath)) {
    console.log('Note: restart the daemon for changes to take effect (myco restart)');
  }
}

/** Parse a string value as JSON (number, boolean, array, object), falling back to raw string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
