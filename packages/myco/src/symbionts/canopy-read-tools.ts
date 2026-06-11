import { parse as shellParse } from 'shell-quote';
import { loadManifests } from './detect.js';
import type { SymbiontManifest, SymbiontCanopyReadTool } from './manifest-schema.js';

export interface ResolvedRead {
  filePath: string;
}

/**
 * Union of canopy read-tool names declared across all installed manifests.
 * Used by SQL aggregators that need to know which activity rows are
 * agent-driven file reads (`Read` for Claude, `Bash` for Codex shell-arg,
 * etc.) without hardcoding agent-specific values.
 *
 * `loadManifests()` is memoized so this is cheap; the returned list is small
 * (~2–3 entries for the foreseeable future).
 */
export function allCanopyReadToolNames(): string[] {
  const names = new Set<string>();
  for (const m of loadManifests()) {
    const tools = m.capabilities?.canopyReadTools;
    if (!tools) continue;
    for (const t of tools) names.add(t.tool);
  }
  return Array.from(names);
}

/**
 * Decide whether (toolName, toolInput) constitutes a file read under the
 * given symbiont's manifest, and return the file path if so. Returns null
 * for unrecognized tools, malformed inputs, or shell commands that don't
 * fall in the manifest's `readCommands` allowlist.
 *
 * Identity-agnostic: matches purely on the manifest's `canopyReadTools`
 * entries — no per-symbiont code paths.
 */
export function resolveCanopyReadTool(
  manifest: SymbiontManifest | undefined,
  toolName: string,
  toolInput: unknown,
): ResolvedRead | null {
  return resolveFromEntries(manifest?.capabilities?.canopyReadTools, toolName, toolInput);
}

/**
 * Union of path-bearing tool names declared across all installed manifests.
 * Companion to `allCanopyReadToolNames()`; this is the broader list (Write,
 * Edit, MultiEdit, etc.) that PostToolUse capture consults to populate
 * `activities.file_path` for the FTS index and the per-activity UI column.
 */
export function allPathBearingToolNames(): string[] {
  const names = new Set<string>();
  for (const m of loadManifests()) {
    const tools = m.capabilities?.pathBearingTools;
    if (!tools) continue;
    for (const t of tools) names.add(t.tool);
  }
  return Array.from(names);
}

/**
 * Decide whether (toolName, toolInput) carries an extractable file path under
 * the given symbiont's manifest, and return it if so. Broader counterpart to
 * `resolveCanopyReadTool` — consults `pathBearingTools` instead of
 * `canopyReadTools` so write-side tools (Write, Edit, MultiEdit, etc.) also
 * populate `activities.file_path` during PostToolUse capture.
 *
 * Same identity-agnostic semantics: shape, shell-arg extraction, and
 * read-command allowlist behaviour mirror the canopy resolver exactly.
 */
export function extractAnyPath(
  manifest: SymbiontManifest | undefined,
  toolName: string,
  toolInput: unknown,
): ResolvedRead | null {
  return resolveFromEntries(manifest?.capabilities?.pathBearingTools, toolName, toolInput);
}

function resolveFromEntries(
  entries: ReadonlyArray<SymbiontCanopyReadTool> | undefined,
  toolName: string,
  toolInput: unknown,
): ResolvedRead | null {
  if (!entries || entries.length === 0) return null;
  if (toolInput === null || typeof toolInput !== 'object') return null;

  const input = toolInput as Record<string, unknown>;

  for (const entry of entries) {
    if (entry.tool !== toolName) continue;

    if ('extract' in entry && entry.extract === 'shell-arg') {
      const resolved = resolveShellArg(entry, input);
      if (resolved) return resolved;
      continue;
    }

    if ('extract' in entry && entry.extract === 'patch') {
      const resolved = resolvePatchFile(entry, input);
      if (resolved) return resolved;
      continue;
    }

    const value = input[entry.pathField];
    if (typeof value === 'string' && value.length > 0) {
      return { filePath: value };
    }
  }

  return null;
}

/**
 * File headers inside an apply_patch envelope. The grammar (shared by
 * Codex and opencode) wraps hunks in `*** Begin Patch` … `*** End Patch`
 * with one header per touched file:
 *
 *     *** Add File: <path>
 *     *** Update File: <path>      (optionally followed by `*** Move to:`)
 *     *** Delete File: <path>
 */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;

/**
 * Extract the file path from an apply_patch envelope string. A single
 * envelope can touch multiple files; the FIRST header wins — one tool
 * call only registers one activity row regardless (mirrors the
 * last-positional compromise in `resolveShellArg`). `*** Move to:`
 * destinations are deliberately not considered — the source header
 * already identifies the file the patch is about.
 */
function resolvePatchFile(
  entry: Extract<SymbiontCanopyReadTool, { extract: 'patch' }>,
  input: Record<string, unknown>,
): ResolvedRead | null {
  const raw = input[entry.pathField];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const match = PATCH_FILE_HEADER.exec(raw);
  if (!match) return null;
  const filePath = match[1].trim();
  return filePath.length > 0 ? { filePath } : null;
}

function resolveShellArg(
  entry: Extract<SymbiontCanopyReadTool, { extract: 'shell-arg' }>,
  input: Record<string, unknown>,
): ResolvedRead | null {
  const raw = input[entry.pathField];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  // shell-quote returns string tokens for plain words and object tokens for
  // operators ({op}), globs ({pattern}), comments ({comment}). Any non-string
  // token anywhere in the sequence signals this isn't a simple cat-style read
  // (pipes, redirects, subshells, globs, command chains all surface here).
  // A bare `$` string token comes from a subshell expansion like `$(...)`
  // whose `(`/`)` arrive as operator objects — treat that as not-simple too.
  let tokens: ReturnType<typeof shellParse>;
  try {
    tokens = shellParse(raw);
  } catch {
    return null;
  }
  if (tokens.length === 0) return null;
  for (const tok of tokens) {
    if (typeof tok !== 'string') return null;
    if (tok === '$') return null;
  }

  const first = tokens[0] as string;
  if (!entry.readCommands.includes(first)) return null;

  // The path is the LAST non-flag positional argument. This handles both
  // first-arg readers (`cat file`, `head -10 file`, `tail -n 5 file`) and
  // trailing-arg readers where a script or pattern precedes the path
  // (`sed -n '1,5p' file`, `rg pattern file`, `perl -ne '…' file`,
  // `awk '/pat/' file`). For commands taking multiple paths
  // (`wc a.txt b.txt`), this captures the last one — acceptable since one
  // Bash call only registers one read regardless.
  let endOfOptions = false;
  let lastPositional: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    // Empty-string tokens come from unset env-var expansion (`$FILE` → "").
    // Treat as "not a simple read".
    if (tok.length === 0) return null;
    if (endOfOptions) {
      lastPositional = tok;
      continue;
    }
    if (tok === '--') {
      endOfOptions = true;
      continue;
    }
    if (tok.length >= 2 && tok.startsWith('-')) {
      continue;
    }
    lastPositional = tok;
  }

  return lastPositional ? { filePath: lastPositional } : null;
}
