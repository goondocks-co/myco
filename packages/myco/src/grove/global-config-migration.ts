/**
 * Global-config one-shot migrations — companion to `runGlobalInstallMigrationPass`
 * in `global-install-migration.ts` for filesystem state outside any single project.
 *
 * Currently:
 *   - {@link scrubGeminiTrustedHooks} — removes stale `myco-*:--symbiont gemini`
 *     entries from `~/.gemini/trusted_hooks.json`.
 *   - {@link scrubEscapedSmokeLaunchers} — removes Myco's own escaped/old
 *     launcher hook entries (any path) from global agent hook files, preserving
 *     foreign hooks, genuine user wrappers, and the current marker-bearing
 *     binary form.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { resolveHomeDir } from './paths.js';

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
 * Filenames of every Myco launcher script the installer ever wrote into a hook
 * command. The NEW launch form is the bare binary (`<path>/myco hook …
 * --myco-managed`) with NO `.cjs` file, so it is deliberately NOT in this list —
 * those entries are the current install and must be preserved.
 */
const MYCO_LAUNCHER_FILES = [
  'launcher.cjs',
  'mcp-launcher.cjs',
  'myco-run.cjs',
  'myco-hook.cjs',
] as const;

/**
 * Known hook events — mirrors `HOOK_DISPATCH` in `cli.ts` and the per-event
 * `hook <event>` shape the templates under `symbionts/templates/<agent>/`
 * emit. A stale list only means a brand-new event's escaped junk wouldn't be
 * scrubbed (fail-safe), never that a real hook is wrongly removed.
 */
const KNOWN_HOOK_EVENTS = new Set([
  'session-start',
  'session-end',
  'stop',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'post-tool-use-failure',
  'subagent-start',
  'subagent-stop',
  'stop-failure',
  'task-completed',
  'pre-compact',
  'post-compact',
  'error-occurred',
  'notification',
]);

/**
 * Known symbionts — mirrors the manifest filenames under
 * `symbionts/manifests/<name>.yaml`. As with {@link KNOWN_HOOK_EVENTS}, a stale
 * list is fail-safe: a brand-new symbiont's escaped junk just wouldn't be
 * scrubbed until this set is updated.
 */
const KNOWN_SYMBIONTS = new Set([
  'antigravity',
  'claude-code',
  'codex',
  'copilot',
  'cursor',
  'opencode',
  'pi',
  'windsurf',
]);

/**
 * Myco's full hook signature: `hook <event> --symbiont <agent>` (the `=` or
 * space form). Captures the event and symbiont so they can be validated against
 * the known sets.
 */
const MYCO_HOOK_SIGNATURE = /\bhook\s+([\w-]+)\s+--symbiont(?:=|\s+)([\w-]+)/;

/**
 * A LEADING Myco `cd "…" && ` prefix the installer prepends so the launcher runs
 * from the project root. Stripped before the shell-operator check so Myco's own
 * `cd "${CLAUDE_PROJECT_DIR:-.}" && node …/launcher.cjs hook …` form is not
 * mistaken for a user composition.
 */
const LEADING_CD_PREFIX = /^\s*cd\s+(["'])[^"']*\1\s*&&\s*/;

/** Shell operators that signal a user-composed command (not a bare Myco launch). */
const SHELL_OPERATOR = /(\&\&|\|\||;|\||>)/;

/**
 * Historical escaped/old launcher entries: real installs (smoke sandboxes,
 * dogfood daemons, and the pre-binary canonical `~/.myco/launcher.cjs` form)
 * left `<path>/launcher.cjs hook <event> --symbiont <agent>` entries in real
 * global hook files (`~/.claude/settings.json`, `~/.cursor/hooks.json`, etc.) at
 * varying temp paths. The steady-state installer keys ownership on the NEW
 * marker-bearing binary form and leaves these `.cjs` entries alone; this scrub
 * is the one-shot healing path that removes them by their full Myco signature,
 * at any path, without touching foreign hooks or genuine user wrappers.
 */
const HOOKS_ROOT_KEY = 'hooks';

function currentHomeDir(): string {
  return resolveHomeDir();
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
 * Remove Myco's own escaped/old launcher hook groups from a JSON hooks/settings
 * file, by their full launcher signature at any path.
 *
 * Preserves:
 *   - non-Myco co-tenant entries (GitKraken, other apps' hook scripts, etc.)
 *   - genuine user wrappers that invoke a Myco launcher file but lack the full
 *     `hook <known-event> --symbiont <known-agent>` signature or carry a shell
 *     composition
 *   - the NEW marker-bearing binary form (`<path>/myco hook … --myco-managed`,
 *     no `.cjs`) — the current install
 *
 * Removes any command matching {@link isMycoEscapedLauncherCommand}: a Myco
 * launcher FILE plus the full hook signature with a known event and symbiont,
 * not user-composed.
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
      if (isMycoEscapedLauncherGroup(group)) {
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

/**
 * A hook group is Myco escaped/old launcher junk to remove when its command(s)
 * are. Flat groups carry a single `command`; nested groups carry a `hooks` array
 * — those are removed only when EVERY command matches, so one foreign command in
 * the group protects the whole group.
 */
function isMycoEscapedLauncherGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  const entry = group as Record<string, unknown>;

  if (typeof entry.command === 'string') {
    return isMycoEscapedLauncherCommand(entry.command);
  }
  if (Array.isArray(entry.hooks)) {
    const commands = entry.hooks
      .filter((hook): hook is Record<string, unknown> => !!hook && typeof hook === 'object' && !Array.isArray(hook))
      .map((hook) => hook.command)
      .filter((command): command is string => typeof command === 'string');
    return commands.length > 0 && commands.every(isMycoEscapedLauncherCommand);
  }
  return false;
}

/**
 * A command is a Myco escaped/old launcher entry to REMOVE iff ALL of:
 *   1. it invokes a Myco launcher FILE ({@link MYCO_LAUNCHER_FILES}) — the new
 *      bare-binary `<path>/myco hook … --myco-managed` form has no `.cjs` file
 *      and is therefore NOT matched;
 *   2. it carries Myco's full hook signature with a KNOWN event AND a KNOWN
 *      symbiont ({@link MYCO_HOOK_SIGNATURE}, {@link KNOWN_HOOK_EVENTS},
 *      {@link KNOWN_SYMBIONTS}); and
 *   3. it is NOT user-composed — after stripping a leading Myco `cd "…" && `
 *      prefix, the remainder contains no shell operators.
 */
function isMycoEscapedLauncherCommand(command: string): boolean {
  if (!MYCO_LAUNCHER_FILES.some((file) => command.includes(file))) return false;

  const match = MYCO_HOOK_SIGNATURE.exec(command);
  if (!match) return false;
  const [, event, symbiont] = match;
  if (!KNOWN_HOOK_EVENTS.has(event) || !KNOWN_SYMBIONTS.has(symbiont)) return false;

  const remainder = command.replace(LEADING_CD_PREFIX, '');
  if (SHELL_OPERATOR.test(remainder)) return false;

  return true;
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
