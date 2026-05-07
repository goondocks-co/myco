import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { TeamSchema, type TeamConfig } from '@myco/config/schema.js';
import { loadMergedConfig, updateTeamConfig } from '@myco/config/loader.js';
import { readSecrets, writeSecret } from '@myco/config/secrets.js';
import { resolveGroveConfigPath, resolveGroveDir } from '@myco/grove/paths.js';
import { isGroveScoped, type MycoRequestContext } from '@myco/tools/request-context.js';

export interface TeamConnectionStore {
  configDir: string;
  configPath: string;
  secretsDir: string;
  /** Non-null when the store is backed by a Grove; null for legacy project-local vaults. */
  groveId: string | null;
}

interface GroveConfigDoc {
  team?: Partial<TeamConfig>;
  [key: string]: unknown;
}

export function resolveTeamConnectionStore(
  fallbackVaultDir: string,
  requestContext?: MycoRequestContext,
): TeamConnectionStore {
  if (isGroveScoped(requestContext)) {
    const groveId = requestContext!.groveId!;
    const configDir = resolveGroveDir(groveId);
    return {
      configDir,
      configPath: resolveGroveConfigPath(groveId),
      secretsDir: configDir,
      groveId,
    };
  }

  return {
    configDir: fallbackVaultDir,
    configPath: path.join(fallbackVaultDir, 'myco.yaml'),
    secretsDir: fallbackVaultDir,
    groveId: null,
  };
}

export function loadTeamConnectionConfig(
  fallbackVaultDir: string,
  requestContext?: MycoRequestContext,
): TeamConfig {
  const store = resolveTeamConnectionStore(fallbackVaultDir, requestContext);
  if (!store.groveId) return loadMergedConfig(fallbackVaultDir).team;
  const doc = readGroveConfig(store.configPath);
  return parseTeamConfig(doc.team ?? {});
}

export function updateTeamConnectionConfig(
  fallbackVaultDir: string,
  requestContext: MycoRequestContext | undefined,
  patch: Partial<TeamConfig>,
): TeamConfig {
  const store = resolveTeamConnectionStore(fallbackVaultDir, requestContext);
  if (!store.groveId) {
    return updateTeamConfig(fallbackVaultDir, patch).team;
  }

  const doc = readGroveConfig(store.configPath);
  const next = parseTeamConfig({ ...(doc.team ?? {}), ...patch });
  doc.team = next;
  fs.mkdirSync(path.dirname(store.configPath), { recursive: true });
  fs.writeFileSync(store.configPath, YAML.stringify(doc), 'utf-8');
  return next;
}

export function readTeamConnectionSecrets(
  fallbackVaultDir: string,
  requestContext?: MycoRequestContext,
): Record<string, string> {
  const store = resolveTeamConnectionStore(fallbackVaultDir, requestContext);
  return readSecrets(store.secretsDir);
}

export function writeTeamConnectionSecret(
  fallbackVaultDir: string,
  requestContext: MycoRequestContext | undefined,
  key: string,
  value: string,
): void {
  const store = resolveTeamConnectionStore(fallbackVaultDir, requestContext);
  writeSecret(store.secretsDir, key, value);
}

function readGroveConfig(filePath: string): GroveConfigDoc {
  if (!fs.existsSync(filePath)) return {};
  const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as GroveConfigDoc
    : {};
}

function parseTeamConfig(team: Partial<TeamConfig>): TeamConfig {
  return TeamSchema.parse(team);
}
