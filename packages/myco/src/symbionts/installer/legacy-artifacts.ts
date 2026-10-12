import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/names.js';

/** Filename when installed into the project .agents/ directory. */
const HOOK_GUARD_INSTALLED_FILENAME = 'myco-run.cjs';

/** Project-local CLI launcher installed beside the capture hook guard. */
const CLI_LAUNCHER_INSTALLED_FILENAME = 'myco-cli.cjs';

/** Project-relative path where the hook guard is installed. */
export const HOOK_GUARD_PROJECT_PATH = `.agents/${HOOK_GUARD_INSTALLED_FILENAME}`;

/** Project-relative path where the CLI launcher is installed. */
export const CLI_LAUNCHER_PROJECT_PATH = `.agents/${CLI_LAUNCHER_INSTALLED_FILENAME}`;

/** Retired hook guard eligible for launcher cleanup. */
export const LEGACY_HOOK_GUARD_PATH = '.agents/myco-hook.cjs';

/** Canonical cross-agent skills directory (single source of truth in skills/names). */
export const CANONICAL_SKILLS_DIR = CANONICAL_PROJECT_SKILLS_DIR;

/** Built-in skill names retired from the package but still present in older installs. */
export const LEGACY_BUILTIN_SKILL_NAMES = ['myco-curate', 'rules'];

/**
 * Active project-shared launchers written by `installHookGuard`. Shared
 * because every symbiont in a project points at the same guard(s), so
 * removing them during one symbiont uninstall can break the remaining
 * symbionts.
 */
const ACTIVE_PROJECT_LAUNCHERS = [
  HOOK_GUARD_PROJECT_PATH,
  CLI_LAUNCHER_PROJECT_PATH,
] as const;

/** Retired launcher artifact — always safe to remove when found. */
const LEGACY_PROJECT_LAUNCHERS = [LEGACY_HOOK_GUARD_PATH] as const;

/** Project-relative path of the runtime-binary pin written by `make dev-link`. */
const PROJECT_RUNTIME_COMMAND_PATH = path.join('.myco', 'runtime.command');

/**
 * Selection knobs for `removeProjectLaunchers`. The walker uses
 * `legacy: true, active: !optIn, runtimeCommand: !optIn` so it can
 * always clean retired artifacts while honoring the project-local
 * opt-in for active launchers + dev pin. `myco remove` opts into all
 * three.
 */
export interface RemoveProjectLaunchersOptions {
  /** Remove the retired `.agents/myco-hook.cjs` guard. Default: true. */
  legacy?: boolean;
  /** Remove active project launchers (`myco-run.cjs`, `myco-cli.cjs`). Default: true. */
  active?: boolean;
  /** Remove `.myco/runtime.command` (the dev pin / opt-in surface). Default: false. */
  runtimeCommand?: boolean;
}

/**
 * Remove project-shared launcher artifacts. Returns the project-
 * relative paths that were actually unlinked. ENOENT is silent (the
 * common "nothing to remove" case); any other error is logged and
 * skipped so a stuck file on one path doesn't abort cleanup of the
 * rest — the caller's audit log surfaces aggregate state via the
 * returned list.
 *
 * Project-level operation: per-symbiont uninstall must not call
 * this. Walker and `myco remove` are the canonical callers.
 */
export function removeProjectLaunchers(
  projectRoot: string,
  options: RemoveProjectLaunchersOptions = {},
): string[] {
  const { legacy = true, active = true, runtimeCommand = false } = options;
  const targets: string[] = [];
  if (active) targets.push(...ACTIVE_PROJECT_LAUNCHERS);
  if (legacy) targets.push(...LEGACY_PROJECT_LAUNCHERS);
  if (runtimeCommand) targets.push(PROJECT_RUNTIME_COMMAND_PATH);

  const removed: string[] = [];
  for (const rel of targets) {
    try {
      fs.unlinkSync(path.join(projectRoot, rel));
      removed.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      // eslint-disable-next-line no-console
      console.error(`  ⚠ Could not remove ${rel}: ${(err as Error).message}`);
    }
  }
  return removed;
}
