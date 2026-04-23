/**
 * Code exploration tools: filesystem reads + ripgrep content search.
 *
 * 4 tools: fs_read, fs_list, fs_tree, code_grep
 *
 * Unlike the vault tools, these operate on the user's project files rather
 * than the vault database. They're scoped to `projectRoot` — any path that
 * resolves outside the root is rejected. Available to tasks that explicitly
 * request them (notably vault-seed, which has no session data to draw on
 * and must infer knowledge from source).
 *
 * Frugality is a first-class design goal. Tool responses and descriptions
 * mirror Claude Code's native conventions: bounded default output sizes,
 * explicit paging via offset-style args, and descriptions that teach
 * narrow-first exploration. The alternative is a tight feedback loop
 * where the agent reads gigabytes in a handful of turns and burns the
 * provider's token-per-minute cap before doing any useful work.
 *
 * Schema note: Zod argument shapes use plain `.optional()` / `.string()` /
 * `.number()` and avoid `.default()`, `.min()`, `.max()`, `.int()`,
 * `.positive()` because OpenAI's strict function-calling rejects the
 * JSON-schema keywords those produce (`default`, `minimum`, `maximum`,
 * `exclusiveMinimum`). The defaulting and clamping happens in the handler
 * instead — same behavior, compatible with both SDKs.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { getRipgrepPath } from '../../runtime/native-deps.js';
import { z } from 'zod/v4';
import { textResult, type VaultToolDeps } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Limits and defaults (applied in handlers, not schemas)
// ---------------------------------------------------------------------------

/**
 * Cap on bytes returned by fs_read when the agent reads an entire file.
 * Protects against 1MB+ generated files blowing the budget in a single call.
 * Most source files are well under this; paged reads are preferred regardless.
 */
const MAX_FILE_BYTES = 500_000;
/** Default line count for fs_read when the agent omits start/end. Matches Claude Code's convention. */
const DEFAULT_READ_LINES = 200;
/** Hard ceiling on fs_read line window regardless of args. */
const MAX_READ_LINES = 2000;
/** Default entries-per-directory cap for fs_list. */
const DEFAULT_LIST_LIMIT = 200;
/** Absolute ceiling on fs_list limit regardless of what the agent passes. */
const MAX_LIST_LIMIT = 1000;
/** Default recursion depth for fs_tree — intentionally shallow. */
const DEFAULT_TREE_DEPTH = 1;
/** Max recursion depth allowed for fs_tree regardless of input. */
const MAX_TREE_DEPTH = 4;
/** Max total tree entries surfaced per fs_tree call — tail-truncates with a marker. */
const MAX_TREE_ENTRIES = 200;
/** Default result cap for code_grep. */
const DEFAULT_GREP_RESULTS = 50;
/** Hard ceiling on code_grep matches — ripgrep is stopped as soon as we hit this. */
const MAX_GREP_RESULTS = 200;
/** Max context lines allowed per grep match. */
const MAX_GREP_CONTEXT = 5;
/** Per-match text cap for code_grep — survives minified files without blowing the budget. */
const MAX_GREP_MATCH_CHARS = 200;
/** Directories skipped by fs_tree and fs_list during recursive walk. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.myco', '.agents', '.turbo', '.cache', 'out',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Guard at call time rather than factory time so the tools always register
 * in the runtime tool registry. Callers without a project root get a clear
 * error instead of a silently missing tool.
 */
function assertProjectRoot(projectRoot: string | undefined): asserts projectRoot is string {
  if (!projectRoot) {
    throw new Error('Code exploration tools require a project root; none was configured for this run.');
  }
}

/**
 * Resolve `inputPath` relative to `projectRoot` and reject anything that
 * escapes it. Returns the absolute path inside the project.
 */
function resolveScoped(projectRoot: string | undefined, inputPath: string): string {
  assertProjectRoot(projectRoot);
  const resolved = path.resolve(projectRoot, inputPath);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path resolves outside project root: ${inputPath}`);
  }
  return resolved;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return Math.min(Math.max(n, min), max);
}

function truncateLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExplorationTools(deps: VaultToolDeps) {
  const { projectRoot } = deps;

  const fsRead = tool(
    'fs_read',
    `Read a window of lines from a text file. Paths are resolved relative to the project root; paths that escape the root are rejected. ` +
    `By default returns up to ${DEFAULT_READ_LINES} lines starting at the top. Page through longer files with start_line + end_line (1-indexed, inclusive). ` +
    `The response includes total_lines so you know how much remains. Prefer narrow line windows over whole-file reads. ` +
    `Files larger than ${Math.floor(MAX_FILE_BYTES / 1000)}KB are head+tail truncated before line-slicing. Max window: ${MAX_READ_LINES} lines.`,
    {
      path: z.string().describe('File path relative to the project root.'),
      start_line: z.number().optional().describe(`First line to return (1-indexed). Omit to start at line 1.`),
      end_line: z.number().optional().describe(`Last line to return (inclusive). Omit to return the default window (${DEFAULT_READ_LINES} lines from start_line).`),
    },
    async (args) => {
      const fullPath = resolveScoped(projectRoot, args.path);
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) throw new Error(`Not a file: ${args.path}`);

      let content = await fs.promises.readFile(fullPath, 'utf-8');
      let bytesTruncated = false;
      if (stat.size > MAX_FILE_BYTES) {
        const half = Math.floor(MAX_FILE_BYTES / 2);
        content = `${content.slice(0, half)}\n\n... [truncated ${stat.size - MAX_FILE_BYTES} bytes] ...\n\n${content.slice(-half)}`;
        bytesTruncated = true;
      }

      const lines = content.split('\n');
      const totalLines = lines.length;

      const requestedStart = args.start_line !== undefined ? Math.max(1, Math.trunc(args.start_line)) : 1;
      const requestedEnd = args.end_line !== undefined
        ? Math.max(requestedStart, Math.trunc(args.end_line))
        : requestedStart + DEFAULT_READ_LINES - 1;
      const cappedEnd = Math.min(requestedEnd, requestedStart + MAX_READ_LINES - 1, totalLines);

      const sliced = lines.slice(requestedStart - 1, cappedEnd).join('\n');
      const linesTruncated = cappedEnd < totalLines || cappedEnd < requestedEnd;

      return textResult({
        path: args.path,
        size: stat.size,
        total_lines: totalLines,
        start_line: requestedStart,
        end_line: cappedEnd,
        bytes_truncated: bytesTruncated,
        truncated: linesTruncated,
        content: sliced,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  const fsList = tool(
    'fs_list',
    `List entries in ONE directory (non-recursive). Returns name, type (file|dir|other), and size for each. ` +
    `Start narrow: call with path="." to see the top level, then drill into specific subdirs. ` +
    `Dotfiles are hidden unless include_hidden=true. Use fs_tree for nested structure, not fs_list in a loop. ` +
    `Defaults: path=".", include_hidden=false, limit=${DEFAULT_LIST_LIMIT} (max ${MAX_LIST_LIMIT}).`,
    {
      path: z.string().optional().describe('Directory path relative to the project root (default ".").'),
      include_hidden: z.boolean().optional().describe('Include entries starting with "." (default false).'),
      limit: z.number().optional().describe(`Max entries to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`),
    },
    async (args) => {
      const targetPath = args.path ?? '.';
      const includeHidden = args.include_hidden === true;
      const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);

      const fullPath = resolveScoped(projectRoot, targetPath);
      const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
      const visible = includeHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
      const sorted = visible.sort((a, b) => {
        // Directories first, then alphabetical.
        const dirDiff = Number(b.isDirectory()) - Number(a.isDirectory());
        return dirDiff !== 0 ? dirDiff : a.name.localeCompare(b.name);
      });
      const limited = sorted.slice(0, limit);
      const items = await Promise.all(limited.map(async (entry) => {
        // Only stat files — directory sizes aren't reported, so the syscall
        // would be discarded. Cuts syscalls roughly in half on dir-heavy paths.
        const isFile = entry.isFile();
        const stat = isFile
          ? await fs.promises.stat(path.join(fullPath, entry.name)).catch(() => null)
          : null;
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : isFile ? 'file' : 'other',
          size: stat?.size ?? null,
        };
      }));
      return textResult({
        path: targetPath,
        total: visible.length,
        truncated: visible.length > limit,
        items,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  const fsTree = tool(
    'fs_tree',
    `Print a shallow directory tree. Skips common noise (node_modules, .git, dist, build, .myco, .agents, etc.). ` +
    `Start with depth=1 at "." to survey the top level, then drill into specific subdirectories with deeper depth if needed. ` +
    `The response is hard-capped at ${MAX_TREE_ENTRIES} entries and tail-truncates with a "… N more hidden" marker; going deep on a big repo will hit the cap and hide useful structure. ` +
    `Defaults: path=".", depth=${DEFAULT_TREE_DEPTH} (max ${MAX_TREE_DEPTH}), include_hidden=false.`,
    {
      path: z.string().optional().describe('Root directory relative to the project root (default ".").'),
      depth: z.number().optional().describe(`Recursion depth (default ${DEFAULT_TREE_DEPTH}, max ${MAX_TREE_DEPTH}). Start with 1 and go deeper only for specific subtrees.`),
      include_hidden: z.boolean().optional().describe('Include entries starting with "." (default false).'),
    },
    async (args) => {
      const targetPath = args.path ?? '.';
      const depth = clampInt(args.depth, DEFAULT_TREE_DEPTH, 1, MAX_TREE_DEPTH);
      const includeHidden = args.include_hidden === true;

      const root = resolveScoped(projectRoot, targetPath);

      const lines: string[] = [];
      let hiddenCount = 0;

      async function walk(dir: string, remainingDepth: number, prefix: string): Promise<void> {
        if (remainingDepth <= 0) return;
        const raw = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        const entries = raw
          .filter((e) => !IGNORE_DIRS.has(e.name))
          .filter((e) => includeHidden || !e.name.startsWith('.'))
          .sort((a, b) => {
            const dirDiff = Number(b.isDirectory()) - Number(a.isDirectory());
            return dirDiff !== 0 ? dirDiff : a.name.localeCompare(b.name);
          });

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          if (lines.length >= MAX_TREE_ENTRIES) {
            hiddenCount += entries.length - i;
            // Account for subdirectory descendants we won't walk into.
            return;
          }
          const connector = isLast ? '└── ' : '├── ';
          const suffix = entry.isDirectory() ? '/' : '';
          lines.push(`${prefix}${connector}${entry.name}${suffix}`);
          if (entry.isDirectory() && remainingDepth > 1) {
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            await walk(path.join(dir, entry.name), remainingDepth - 1, childPrefix);
          }
        }
      }

      await walk(root, depth, '');
      const treeText = hiddenCount > 0
        ? `${lines.join('\n')}\n… ${hiddenCount} more entries hidden (cap ${MAX_TREE_ENTRIES}); call fs_tree on a narrower path or fs_list on a specific directory`
        : lines.join('\n');

      return textResult({
        path: targetPath,
        depth,
        entries_returned: lines.length,
        entries_hidden: hiddenCount,
        tree: treeText,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  const codeGrep = tool(
    'code_grep',
    `Search file contents using ripgrep. Returns up to ${MAX_GREP_RESULTS} matches (path, line number, matched text). ` +
    `Honors .gitignore by default and skips binary files. Matched lines are truncated at ${MAX_GREP_MATCH_CHARS} chars to survive minified files. ` +
    `Use this instead of reading many files when looking for a pattern — it is dramatically faster and cheaper. ` +
    `Narrow aggressively: prefer a concrete directory over "." and a glob filter (e.g. "*.ts") when you know the language. ` +
    `Defaults: path=".", case_insensitive=false, context_lines=0, max_results=${DEFAULT_GREP_RESULTS} (max ${MAX_GREP_RESULTS}).`,
    {
      pattern: z.string().describe('Regex pattern (ripgrep / Rust regex syntax).'),
      path: z.string().optional().describe('Directory or file to search, relative to the project root (default ".").'),
      glob: z.string().optional().describe('Optional glob filter, e.g. "*.ts" or "!**/*.test.ts".'),
      case_insensitive: z.boolean().optional().describe('Case-insensitive match (default false).'),
      context_lines: z.number().optional().describe(`Lines of surrounding context to include per match (default 0, max ${MAX_GREP_CONTEXT}). Increase only when line-only output is ambiguous.`),
      max_results: z.number().optional().describe(`Max matches to return (default ${DEFAULT_GREP_RESULTS}, max ${MAX_GREP_RESULTS}).`),
    },
    async (args) => {
      const targetPath = args.path ?? '.';
      const caseInsensitive = args.case_insensitive === true;
      const contextLines = clampInt(args.context_lines, 0, 0, MAX_GREP_CONTEXT);
      const maxResults = clampInt(args.max_results, DEFAULT_GREP_RESULTS, 1, MAX_GREP_RESULTS);

      assertProjectRoot(projectRoot);
      const searchPath = resolveScoped(projectRoot, targetPath);
      const rgArgs: string[] = [
        '--json',
        '--max-count', String(maxResults),
        ...(caseInsensitive ? ['-i'] : []),
        ...(contextLines > 0 ? ['-C', String(contextLines)] : []),
        ...(args.glob ? ['-g', args.glob] : []),
        '--', args.pattern, searchPath,
      ];

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(getRipgrepPath(), rgArgs, { maxBuffer: 10_000_000 }));
      } catch (err) {
        // ripgrep exits 1 when no matches — treat as empty result, not error.
        const exitCode = (err as { code?: number }).code;
        if (exitCode === 1) {
          return textResult({ pattern: args.pattern, matches: [], truncated: false });
        }
        throw err;
      }

      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let evt: { type?: string; data?: { path?: { text?: string } | string; line_number?: number; lines?: { text?: string } } };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type !== 'match' || !evt.data) continue;
        const rawPath = typeof evt.data.path === 'string' ? evt.data.path : evt.data.path?.text;
        if (!rawPath) continue;
        const relPath = path.relative(projectRoot, rawPath);
        matches.push({
          path: relPath,
          line: evt.data.line_number ?? 0,
          text: truncateLine((evt.data.lines?.text ?? '').replace(/\n$/, ''), MAX_GREP_MATCH_CHARS),
        });
        if (matches.length >= maxResults) break;
      }
      return textResult({
        pattern: args.pattern,
        matches,
        truncated: matches.length >= maxResults,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  return [fsRead, fsList, fsTree, codeGrep];
}
