import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

const DEFAULT_AGENTS_STARTER = `# Project Rules

<!-- This starter file was created by Myco. Replace it with your project's rules and conventions. -->

Rules haven't been defined yet. Use the /myco-rules skill to add durable project rules, or edit this file directly.
`;

/**
 * Substring patterns identifying a Myco launcher reference in any
 * string. Single source of truth for "does this carry a reference to
 * one of Myco's launcher entry points?" — used by both the hook-
 * command detector (an existing hook entry) and the plugin-file
 * detector (a verbatim plugin source file). If the next launcher
 * rename adds or drops a name, this list is the only place to update.
 *
 * Three shapes:
 *   1. `.agents/myco-run.cjs`  — project-local launcher (per-project commit-to-repo opt-in).
 *   2. `.agents/myco-hook.cjs` — legacy cross-platform guard (pre-rename).
 *   3. `.myco/launcher.cjs`    — user-global launcher (`installScope: 'global'`).
 *      Substring match catches both the absolute-path form Myco writes at
 *      install time (`node "/Users/.../.myco/launcher.cjs"`) and any future
 *      shell-expanded variants (`node "$HOME/.myco/launcher.cjs"`).
 *
 * Ownership identity: any hook command containing one of these substrings
 * is Myco-owned. The launcher paths are unique to Myco — no third-party
 * tenant has reason to invoke them — so the substring scan is the
 * authoritative ownership signal. Earlier versions added a parallel
 * `_meta.owner` marker on hook groups, but that broke strict-schema
 * agents like Windsurf which silently reject hooks.json entries with
 * unknown fields. The marker is gone; the launcher path stands alone.
 */
export const MYCO_LAUNCHER_SUBSTRINGS = [
  '.agents/myco-run.cjs',
  '.agents/myco-hook.cjs',
  '.myco/launcher.cjs',
] as const;

/**
 * Whether `content` references one of Myco's launcher paths. Operates
 * on any string — a hook command line or an entire plugin source file.
 * Pure substring scan, no startsWith semantics.
 */
export function containsMycoLauncherReference(content: string): boolean {
  return MYCO_LAUNCHER_SUBSTRINGS.some((s) => content.includes(s));
}

/**
 * Check if a hook command string belongs to Myco.
 *
 * Matches:
 *   1. Any canonical launcher-substring reference (project-local guard,
 *      legacy guard, or user-global launcher).
 *   2. The bare `myco-run` prefix used by the published MCP entry
 *      point and the old shell shim.
 *
 * The launcher paths are exclusive to Myco — third-party tenants have
 * no reason to call them — so a substring match is the authoritative
 * ownership signal. Earlier installs stamped a parallel `_meta.owner`
 * marker but that broke strict-schema agents; the marker is retired
 * and ownership is identified by the command alone.
 */
export function isMycoHookCommand(command: string): boolean {
  if (containsMycoLauncherReference(command)) return true;
  if (command.startsWith('myco-run')) return true;
  return false;
}

/**
 * Check if a hook group is Myco-owned. Detects both shapes Myco-managed
 * agent configs use:
 *
 *   Nested (Claude Code, Codex, Copilot):
 *     { hooks: [{ command: "node /Users/.../launcher.cjs ..." }] }
 *
 *   Flat (Cursor, Windsurf):
 *     { command: "node /Users/.../launcher.cjs ..." }
 *
 * The launcher path embedded in the command string is the ownership
 * signal. Any hook entry whose command references one of the canonical
 * launcher paths is Myco-owned; any entry whose command does not is a
 * third-party co-tenant entry and must be preserved on reinstall.
 */
export function isMycoHookGroup(group: Record<string, unknown>): boolean {
  // Nested format: { hooks: [{ command: "..." }] }
  if (Array.isArray(group.hooks) && group.hooks.some((h: { command?: string }) => h.command && isMycoHookCommand(h.command))) return true;
  // Flat format: { command: "..." }
  if (typeof group.command === 'string' && isMycoHookCommand(group.command)) return true;
  return false;
}

/**
 * Create a starter AGENTS.md if the project doesn't have one.
 * Idempotent — skips if AGENTS.md already exists.
 */
export function ensureAgentsMd(projectRoot: string): void {
  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) return;

  fs.writeFileSync(
    agentsMdPath,
    BUNDLED_TEMPLATES['agents-starter.md'] ?? DEFAULT_AGENTS_STARTER,
    'utf-8',
  );
}

export function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
  } catch { /* does not exist or is not a symlink — proceed */ }
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(target, linkPath);
}
