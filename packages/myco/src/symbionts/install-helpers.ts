import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

const DEFAULT_AGENTS_STARTER = `# Project Rules

<!-- This starter file was created by Myco. Replace it with your project's rules and conventions. -->

Rules haven't been defined yet. Use the /myco-rules skill to add durable project rules, or edit this file directly.
`;

/**
 * Marker stamped onto every Myco-written hook group. Identity is
 * recorded by the writer, not inferred from the command string — that's
 * what makes reinstall atomic and idempotent for co-tenant JSON files
 * (Claude, Cursor, Codex, Copilot, Windsurf) where we share the file
 * with third-party tenants. The marker survives launcher path changes,
 * sandbox relocations, and reinstalls.
 *
 * Stored under the `_meta` namespace rather than a top-level key so
 * future tenants that enforce strict schema validation on hook groups
 * can opt to ignore `_meta` (the conventional metadata sidecar pattern)
 * instead of rejecting the whole file. Shape:
 *   { ...group, _meta: { owner: 'myco' } }
 */
export const MYCO_META_KEY = '_meta';
export const MYCO_OWNER_FIELD = 'owner';
export const MYCO_OWNER_VALUE = 'myco';

interface MycoMeta {
  [MYCO_OWNER_FIELD]?: string;
  [k: string]: unknown;
}

/**
 * Tag a hook group as Myco-owned. Mutates in place and returns the
 * same reference so callers can chain. Idempotent — re-marking a
 * group preserves any other `_meta` fields a future writer might
 * have added.
 */
export function markGroupAsMyco<T extends Record<string, unknown>>(group: T): T {
  const existing = (group as { _meta?: MycoMeta })[MYCO_META_KEY];
  const meta: MycoMeta = existing && typeof existing === 'object' ? existing : {};
  meta[MYCO_OWNER_FIELD] = MYCO_OWNER_VALUE;
  (group as Record<string, unknown>)[MYCO_META_KEY] = meta;
  return group;
}

/**
 * Check the marker presence directly. Used by the strip step in
 * `installer.ts` — every group with this marker is Myco-owned and
 * must be removed before the new template is appended.
 */
export function hasMycoOwnerMarker(group: Record<string, unknown>): boolean {
  const meta = group[MYCO_META_KEY];
  if (!meta || typeof meta !== 'object') return false;
  return (meta as MycoMeta)[MYCO_OWNER_FIELD] === MYCO_OWNER_VALUE;
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
 *      legacy guard, or user-global launcher) — the strict identity
 *      signal for groups written before the `_mycoOwner` marker existed.
 *   2. The bare `myco-run` prefix used by the published MCP entry
 *      point and the old shell shim.
 *
 * The `_mycoOwner` marker (see `hasMycoOwnerMarker`) takes precedence
 * over this substring scan for groups Myco wrote after the marker
 * landed. Anything not matching either signal is treated as a
 * non-Myco co-tenant entry and preserved on reinstall — critical
 * because the user is allowed to write their own hooks that legitimately
 * invoke Myco's launcher from a wrapper script, and the substring scan
 * cannot distinguish "Myco wrote this" from "user wrote a hook that
 * happens to call our launcher."
 *
 * The smoke-test escape that produced sandboxed `/tmp/.../launcher.cjs`
 * orphans is closed structurally by the marker + `MYCO_SANDBOX_ROOT`
 * sentinel — no widened substring fallback needed.
 */
export function isMycoHookCommand(command: string): boolean {
  if (containsMycoLauncherReference(command)) return true;
  if (command.startsWith('myco-run')) return true;
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
