/**
 * Global-config one-shot migrations — companion to `runGlobalInstallMigrationPass`
 * in `global-install-migration.ts` for filesystem state outside any single project.
 *
 * Currently:
 *   - {@link scrubGeminiTrustedHooks} — removes stale `myco-*:--symbiont gemini`
 *     entries from `~/.gemini/trusted_hooks.json`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface GlobalConfigMigrationOutcome {
  filePath: string;
  entriesRemoved: number;
  rewritten: boolean;
  error?: string;
}

export interface GlobalConfigMigrationResult {
  outcomes: GlobalConfigMigrationOutcome[];
  noOp: boolean;
}

/** Matches `myco-*:<cmd>` entries that reference the per-project Gemini launcher. */
const GEMINI_ERA_MYCO_HOOK = /^myco-[\w-]+:.*\.agents\/myco-run\.cjs hook [\w-]+ --symbiont gemini\b/;

/**
 * Historical smoke-test escape hatch bug: sandboxed runs wrote temp launchers
 * like `/tmp/myco-<smoke-run>/home/launcher.cjs` into real global hook files
 * (`~/.claude/settings.json`, `~/.cursor/hooks.json`, etc.). These are not
 * canonical Myco-owned launchers, so the steady-state installer preserves them;
 * this scrub is the one-shot healing path.
 */
const STALE_SMOKE_LAUNCHER_SEGMENT = '/tmp/myco-';
const STALE_SMOKE_LAUNCHER_SUFFIX = '/home/launcher.cjs';
const HOOKS_ROOT_KEY = 'hooks';

function currentHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

/**
 * Strip Gemini-era Myco entries from `~/.gemini/trusted_hooks.json`. Idempotent,
 * best-effort, atomic. Returns an outcome describing what changed.
 */
export function scrubGeminiTrustedHooks(
  filePath: string = path.join(currentHomeDir(), '.gemini', 'trusted_hooks.json'),
): GlobalConfigMigrationOutcome {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { filePath, entriesRemoved: 0, rewritten: false };
    }
    return { filePath, entriesRemoved: 0, rewritten: false, error: `read failed: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'unexpected shape' };
  }

  const input = parsed as Record<string, unknown>;
  const cleaned: Record<string, string[]> = {};
  let entriesRemoved = 0;
  for (const [project, entries] of Object.entries(input)) {
    if (!Array.isArray(entries)) {
      (cleaned as Record<string, unknown>)[project] = entries;
      continue;
    }
    const keep: string[] = [];
    for (const entry of entries as unknown[]) {
      if (typeof entry !== 'string') {
        keep.push(entry as string);
        continue;
      }
      if (GEMINI_ERA_MYCO_HOOK.test(entry)) {
        entriesRemoved += 1;
        continue;
      }
      keep.push(entry);
    }
    if (keep.length > 0) cleaned[project] = keep;
  }

  if (entriesRemoved === 0) {
    return { filePath, entriesRemoved: 0, rewritten: false };
  }

  try {
    atomicWriteFileSync(filePath, JSON.stringify(cleaned, null, 2) + '\n');
  } catch (err) {
    return {
      filePath,
      entriesRemoved,
      rewritten: false,
      error: `write failed: ${String(err)}`,
    };
  }
  return { filePath, entriesRemoved, rewritten: true };
}

/**
 * Remove stale smoke-launcher hook groups from a JSON hooks/settings file.
 *
 * Preserves:
 *   - non-Myco co-tenant entries (GitKraken, notifications, etc.)
 *   - the canonical global Myco launcher (`~/.myco/launcher.cjs`)
 *
 * Removes only the known escaped smoke-launcher shape:
 *   - command references `/tmp/myco-<run>/home/launcher.cjs`
 *   - command also carries `--symbiont`
 *
 * Supports both nested hook-group files (`.claude/settings.json`,
 * `.codex/hooks.json`, `.copilot/hooks/...`) and flat files
 * (`.cursor/hooks.json`, `.codeium/windsurf/hooks.json`).
 */
export function scrubEscapedSmokeLaunchers(
  filePath: string,
  options: { apply?: boolean } = {},
): GlobalConfigMigrationOutcome {
  const apply = options.apply !== false;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { filePath, entriesRemoved: 0, rewritten: false };
    }
    return { filePath, entriesRemoved: 0, rewritten: false, error: `read failed: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'unexpected shape' };
  }

  const settings = parsed as Record<string, unknown>;
  const hooks = settings[HOOKS_ROOT_KEY];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { filePath, entriesRemoved: 0, rewritten: false };
  }

  let entriesRemoved = 0;
  const cleanedHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      cleanedHooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (isEscapedSmokeLauncherGroup(group)) {
        entriesRemoved += 1;
        continue;
      }
      kept.push(group);
    }
    cleanedHooks[event] = kept;
  }

  if (entriesRemoved === 0) {
    return { filePath, entriesRemoved: 0, rewritten: false };
  }
  if (!apply) {
    return { filePath, entriesRemoved, rewritten: false };
  }

  settings[HOOKS_ROOT_KEY] = cleanedHooks;
  try {
    atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    return {
      filePath,
      entriesRemoved,
      rewritten: false,
      error: `write failed: ${String(err)}`,
    };
  }
  return { filePath, entriesRemoved, rewritten: true };
}

export function listEscapedSmokeLauncherTargets(homeDir: string = currentHomeDir()): string[] {
  return [
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.codex', 'hooks.json'),
    path.join(homeDir, '.copilot', 'hooks', 'myco-hooks.json'),
    path.join(homeDir, '.cursor', 'hooks.json'),
    path.join(homeDir, '.codeium', 'windsurf', 'hooks.json'),
  ];
}

export function scrubKnownEscapedSmokeLaunchers(homeDir: string = currentHomeDir()): GlobalConfigMigrationOutcome[] {
  return listEscapedSmokeLauncherTargets(homeDir).map((target) => scrubEscapedSmokeLaunchers(target));
}

function isEscapedSmokeLauncherGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  const entry = group as Record<string, unknown>;

  if (typeof entry.command === 'string') {
    return isEscapedSmokeLauncherCommand(entry.command);
  }
  if (Array.isArray(entry.hooks)) {
    const commands = entry.hooks
      .filter((hook): hook is Record<string, unknown> => !!hook && typeof hook === 'object' && !Array.isArray(hook))
      .map((hook) => hook.command)
      .filter((command): command is string => typeof command === 'string');
    return commands.length > 0 && commands.every(isEscapedSmokeLauncherCommand);
  }
  return false;
}

function isEscapedSmokeLauncherCommand(command: string): boolean {
  return command.includes(STALE_SMOKE_LAUNCHER_SEGMENT)
    && command.includes(STALE_SMOKE_LAUNCHER_SUFFIX)
    && command.includes('--symbiont');
}

/**
 * Run every global-config scrub. Idempotent across passes; safe to call from
 * `runGlobalBootstrap` and `myco update`.
 */
export function runGlobalConfigMigration(): GlobalConfigMigrationResult {
  const outcomes: GlobalConfigMigrationOutcome[] = [
    scrubGeminiTrustedHooks(),
    ...scrubKnownEscapedSmokeLaunchers(),
  ];
  return {
    outcomes,
    noOp: outcomes.every((o) => o.entriesRemoved === 0),
  };
}
