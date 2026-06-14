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
 * Marker appended to every Myco-emitted hook command. The robust ownership
 * signal for the direct-binary hook form, whose binary path varies by build
 * (dogfood / prod / worktree) and so can't be matched by a stable path
 * substring. Any hook command carrying this flag is Myco-owned regardless of
 * which binary it invokes; user-authored wrappers never carry it. Detection
 * lands here ahead of the emit-side change so a config written by a newer
 * install is recognized — and collapsed — by this version.
 */
export const MYCO_MANAGED_MARKER = '--myco-managed';

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
  // Canonical launcher paths are written forward-slash, but on Windows the
  // wild hook commands carry backslash paths (`...\.myco\launcher.cjs`).
  // Normalize separators before the scan so Myco recognizes its own Windows
  // entries — otherwise they go unclaimed and accumulate (the 6× duplicate
  // stack). The normalization is scoped to canonical Myco filenames only, so
  // it can't newly claim a user wrapper at a non-canonical path.
  const normalized = content.replaceAll('\\', '/');
  if (MYCO_LAUNCHER_SUBSTRINGS.some((s) => normalized.includes(s))) return true;
  if (normalized.includes('mcp-launcher.cjs')) return true;
  return false;
}

/**
 * Check if a hook command string belongs to Myco.
 *
 * Matches:
 *   1. The `--myco-managed` marker — the ownership signal for the
 *      direct-binary hook form, where the binary path varies by build
 *      and so can't be matched by a stable substring.
 *   2. Any canonical launcher-substring reference (project-local guard,
 *      legacy guard, or user-global launcher).
 *   3. The bare `myco-run` prefix used by the published MCP entry
 *      point and the old shell shim.
 *
 * Both the marker and the launcher paths are exclusive to Myco —
 * third-party tenants have no reason to carry them — so either is an
 * authoritative ownership signal. Detection stays strict: a generic
 * `hook <event> --symbiont <agent>` shape WITHOUT the marker or a
 * canonical path is NOT claimed, so user-authored wrappers and
 * escaped-smoke entries are left alone. Earlier installs stamped a
 * parallel `_meta.owner` marker but that broke strict-schema agents;
 * that marker is retired and ownership is identified by the command alone.
 */
export function isMycoHookCommand(command: string): boolean {
  if (command.includes(MYCO_MANAGED_MARKER)) return true;
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
 * file or directory (NOT a link we created) occupies the link path — user
 * content the installer must never destroy; the caller decides how to surface
 * it.
 */
export type EnsureSymlinkResult = 'linked' | 'unchanged' | 'kept-real-path';

/**
 * Filesystem primitives {@link ensureSymlink} uses to create a link. Injectable
 * so tests can simulate a Windows host that denies symlink creation; production
 * passes the real `node:fs` calls.
 */
export interface SymlinkIo {
  symlinkSync: typeof fs.symlinkSync;
  copyFileSync: typeof fs.copyFileSync;
}

const REAL_SYMLINK_IO: SymlinkIo = { symlinkSync: fs.symlinkSync, copyFileSync: fs.copyFileSync };

/**
 * Point `linkPath` at `target`, replacing only things this installer could
 * have created: a link we made (symlink/junction) or a copy we wrote, or
 * nothing at all. A REAL file or directory at the link path is user content —
 * a hand-authored skill dir, a vendored copy — and is left untouched. This
 * runs from hourly detection ticks, so a destructive replace here turns a
 * naming overlap into silent data loss.
 *
 * Symlink-restricted platforms (Windows without Developer Mode / admin) reject
 * `symlinkSync` with EPERM. Rather than branch on `process.platform`, we let
 * the EPERM drive the fallback: a directory target becomes a junction and a
 * file target a copy — neither needs the symlink privilege. On POSIX,
 * `symlinkSync` never throws EPERM, so the original behavior is preserved
 * exactly.
 */
export function ensureSymlink(linkPath: string, target: string, io: SymlinkIo = REAL_SYMLINK_IO): EnsureSymlinkResult {
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);

  const existing = lstatOrUndefined(linkPath);
  if (existing !== undefined) {
    const linkTarget = readlinkOrNull(linkPath);
    if (linkTarget !== null) {
      // A reparse point — a POSIX symlink or a Windows junction we created.
      if (linkResolvesTo(linkPath, linkTarget, target, resolvedTarget)) return 'unchanged';
      fs.unlinkSync(linkPath);
    } else if (isContentCopyOf(linkPath, resolvedTarget, existing)) {
      // A copy-fallback we wrote earlier (file target, symlink-denied host).
      return 'unchanged';
    } else {
      // A real file or directory = user content. Never destroy it.
      return 'kept-real-path';
    }
  }
  return createLink(linkPath, target, resolvedTarget, io);
}

function createLink(linkPath: string, target: string, resolvedTarget: string, io: SymlinkIo): EnsureSymlinkResult {
  let targetIsDir = false;
  try { targetIsDir = fs.statSync(resolvedTarget).isDirectory(); } catch { /* dangling — treat as file */ }

  try {
    io.symlinkSync(target, linkPath, targetIsDir ? 'dir' : 'file');
    return 'linked';
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    // Symlink privilege denied. Junctions (dirs) and copies (files) need none;
    // both require an ABSOLUTE source path.
    if (targetIsDir) io.symlinkSync(resolvedTarget, linkPath, 'junction');
    else io.copyFileSync(resolvedTarget, linkPath);
    return 'linked';
  }
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try { return fs.lstatSync(p); } catch { return undefined; }
}

function readlinkOrNull(p: string): string | null {
  // Succeeds on symlinks AND Windows junctions; throws EINVAL on a real path.
  try { return fs.readlinkSync(p); } catch { return null; }
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * Whether an existing link points at `target`. The fast path is the exact
 * string a POSIX symlink stores. A junction stores an absolute, possibly
 * `\\?\`-prefixed target that won't string-match a relative call, so fall back
 * to comparing canonicalized real paths.
 */
function linkResolvesTo(linkPath: string, linkTarget: string, target: string, resolvedTarget: string): boolean {
  if (linkTarget === target) return true;
  try { return fs.realpathSync.native(linkPath) === fs.realpathSync.native(resolvedTarget); } catch { return false; }
}

/**
 * Whether a real file at `linkPath` is byte-identical to the source — i.e. a
 * copy we wrote on a symlink-denied host. A differing file is user content and
 * must be kept; a directory is never a copy.
 */
function isContentCopyOf(linkPath: string, resolvedTarget: string, existing: fs.Stats): boolean {
  if (!existing.isFile()) return false;
  try { return fs.readFileSync(linkPath).equals(fs.readFileSync(resolvedTarget)); } catch { return false; }
}
