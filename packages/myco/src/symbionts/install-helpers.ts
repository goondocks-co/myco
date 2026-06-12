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
 *   1. `.agents/myco-run.cjs`  — legacy project-local launcher (pre-global install; cleaned up by migration).
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
 *
 * Intentionally STRICT — only matches the canonical install paths
 * above plus the standalone `mcp-launcher.cjs` filename (unique to
 * Myco's MCP entry point). A user can legitimately author a hook of
 * their own that calls Myco's launcher from a non-canonical wrapper
 * (e.g. `node /opt/me/launcher.cjs --symbiont claude-code && my-step`);
 * see `installer.test.ts` "PRESERVES user-authored hooks that invoke
 * Myco from a non-canonical launcher path". Treating any `launcher.cjs
 * + --symbiont` pair as Myco-owned would claim and overwrite those
 * user entries on every `myco update`.
 *
 * /code-review finding C12 flagged the fragility (a hypothetical
 * historical Myco install at `/opt/myco/launcher.cjs` would NOT match
 * and would orphan on reinstall). The trade-off is intentional:
 * prefer leaving a stale entry behind (recoverable by deletion) over
 * claiming a user's legitimate wrapper (data-loss-shaped). A future
 * `manifests/<agent>.yaml: extraLauncherSubstrings` opt-in could give
 * packagers an explicit way to widen the set without crossing into
 * user-content territory.
 */
export function containsMycoLauncherReference(content: string): boolean {
  if (MYCO_LAUNCHER_SUBSTRINGS.some((s) => content.includes(s))) return true;
  if (content.includes('mcp-launcher.cjs')) return true;
  return false;
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

/**
 * Outcome of an {@link ensureSymlink} call. 'kept-real-path' means a real
 * file or directory (NOT a symlink) occupies the link path — user content
 * the installer must never destroy; the caller decides how to surface it.
 */
export type EnsureSymlinkResult = 'linked' | 'unchanged' | 'kept-real-path';

/**
 * Point `linkPath` at `target`, replacing only things this installer could
 * have created: an existing symlink (wherever it points) or nothing at all.
 * A REAL file or directory at the link path is user content — a
 * hand-authored skill dir, a vendored copy — and is left untouched. This
 * runs from hourly detection ticks, so a destructive replace here turns a
 * naming overlap into silent data loss.
 */
export function ensureSymlink(linkPath: string, target: string): EnsureSymlinkResult {
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(linkPath);
  } catch { /* absent — create below */ }

  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return 'kept-real-path';
    if (fs.readlinkSync(linkPath) === target) return 'unchanged';
    fs.unlinkSync(linkPath);
  }
  fs.symlinkSync(target, linkPath);
  return 'linked';
}
