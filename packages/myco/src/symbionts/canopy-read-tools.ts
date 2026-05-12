import { parse as shellParse } from 'shell-quote';
import type { SymbiontManifest, SymbiontCanopyReadTool } from './manifest-schema.js';

export interface ResolvedRead {
  filePath: string;
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
  const entries = manifest?.capabilities?.canopyReadTools;
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

    const value = input[entry.pathField];
    if (typeof value === 'string' && value.length > 0) {
      return { filePath: value };
    }
  }

  return null;
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
  const tokens = shellParse(raw);
  if (tokens.length === 0) return null;
  for (const tok of tokens) {
    if (typeof tok !== 'string') return null;
    if (tok === '$') return null;
  }

  const first = tokens[0] as string;
  if (!entry.readCommands.includes(first)) return null;

  let endOfOptions = false;
  let prevWasShortLetterFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    // Empty-string tokens come from unset env-var expansion (`$FILE` → "").
    // Treat as "not a simple read".
    if (tok.length === 0) return null;

    if (endOfOptions) {
      return { filePath: tok };
    }
    if (tok === '--') {
      endOfOptions = true;
      prevWasShortLetterFlag = false;
      continue;
    }
    if (tok.length >= 2 && tok.startsWith('-')) {
      // Single-letter short flags (-n, -c, -B) commonly take a separate value
      // (e.g. `tail -n 5 path`). Recognize this so the value isn't mistaken
      // for the path. `-10` and `--long` and `-abc` are not single-letter
      // flags and never consume an argument here.
      prevWasShortLetterFlag = tok.length === 2 && !tok.startsWith('--') && /^-[A-Za-z]$/.test(tok);
      continue;
    }
    if (prevWasShortLetterFlag && /^\d+$/.test(tok)) {
      // Numeric value bound to the previous short flag.
      prevWasShortLetterFlag = false;
      continue;
    }
    return { filePath: tok };
  }

  return null;
}
