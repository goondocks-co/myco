import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

const DEFAULT_AGENTS_STARTER = `# Project Rules

<!-- This starter file was created by Myco. Replace it with your project's rules and conventions. -->

Rules haven't been defined yet. Use the /myco-rules skill to add durable project rules, or edit this file directly.
`;

/**
 * Marker field stamped onto every Myco-written hook group. The presence
 * of this field is the AUTHORITATIVE signal of Myco ownership — the
 * launcher-substring scan below is a soft legacy fallback for groups
 * written before the marker existed.
 *
 * The marker survives across launcher path changes, sandbox relocations,
 * and reinstalls because identity is recorded by the writer, not
 * inferred from the command string. That's what makes reinstall atomic
 * and idempotent for co-tenant JSON files (Claude, Cursor, Codex,
 * Copilot, Windsurf) where we share the file with third-party tenants.
 */
export const MYCO_OWNER_MARKER_KEY = '_mycoOwner';
export const MYCO_OWNER_MARKER_VALUE = 'myco';

/**
 * Tag a hook group as Myco-owned. Mutates in place and returns the
 * same reference so callers can chain. Idempotent.
 */
export function markGroupAsMyco<T extends Record<string, unknown>>(group: T): T {
  group[MYCO_OWNER_MARKER_KEY as keyof T] = MYCO_OWNER_MARKER_VALUE as T[keyof T];
  return group;
}

/**
 * Check the marker presence directly. Used by the strip step in
 * `installer.ts` — every group with this marker is Myco-owned and
 * must be removed before the new template is appended.
 */
export function hasMycoOwnerMarker(group: Record<string, unknown>): boolean {
  return group[MYCO_OWNER_MARKER_KEY] === MYCO_OWNER_MARKER_VALUE;
}

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
 */
const MYCO_LAUNCHER_SUBSTRINGS = [
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
 * Matches in priority order:
 *   1. A canonical launcher-substring reference (project-local guard,
 *      legacy guard, or user-global launcher).
 *   2. The `launcher.cjs` filename combined with the Myco-specific
 *      `--symbiont` flag — catches relocated / sandboxed launcher paths
 *      (e.g. orphan smoke-test entries under `/tmp/`) that don't sit
 *      under a canonical Myco directory. Safe because no other tenant
 *      uses both that filename AND that flag.
 *   3. The bare `myco-run` prefix used by the published MCP entry
 *      point and the old shell shim.
 *
 * Missing any of these breaks the merge/uninstall contract: new hooks
 * append rather than replace, idempotence dies, uninstall leaks. The
 * `_mycoOwner` marker (see `hasMycoOwnerMarker`) takes precedence over
 * this substring scan for groups Myco wrote after the marker landed.
 */
export function isMycoHookCommand(command: string): boolean {
  if (containsMycoLauncherReference(command)) return true;
  if (command.startsWith('myco-run')) return true;
  // Relocated-launcher fallback — catches sandboxed/orphaned launchers
  // whose path doesn't sit under a canonical Myco directory. The flag
  // pair is distinctive enough that a false positive against a
  // third-party launcher would require deliberate spoofing.
  if (command.includes('launcher.cjs') && command.includes('--symbiont')) return true;
  return false;
}

/**
 * Check if a hook group is Myco-owned.
 *
 * Ownership is established by either:
 *   1. The explicit `_mycoOwner` marker (every group Myco writes after
 *      this lands carries it), OR
 *   2. Legacy fallback — the launcher-substring scan on the embedded
 *      command. Pre-marker installs are still recognized so reinstall
 *      cleans them up. Once an install is rewritten with markers, this
 *      branch stops mattering for that file.
 *
 * Handles both nested format (Claude Code, Codex, Copilot) and flat
 * format (Cursor, Windsurf):
 *   Nested: { hooks: [{ command: "node /Users/.../launcher.cjs ..." }], _mycoOwner?: "myco" }
 *   Flat:   { command: "node /Users/.../launcher.cjs ...", _mycoOwner?: "myco" }
 */
export function isMycoHookGroup(group: Record<string, unknown>): boolean {
  if (hasMycoOwnerMarker(group)) return true;
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
