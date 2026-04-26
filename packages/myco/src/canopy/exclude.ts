// Minimal glob matcher for Canopy exclude patterns. We avoid the minimatch dep
// because the default pattern set only needs three shapes: bare segment,
// `**/<basename>`, and `**/<glob>` against the basename.
//
// The scanner uses `createLayeredExcludeMatcher` to compose three layers:
//   1. The project's `.gitignore` (parsed by `./gitignore.ts`)
//   2. Myco-managed segments from the symbiont manifests (`./managed-paths.ts`)
//   3. The user's custom `canopy.exclude.patterns`
// Any layer saying "exclude" wins; gitignore negations apply only within
// the gitignore layer (they don't un-exclude anything the other layers ban).
import { loadProjectGitignoreMatcher } from './gitignore.js';
import { getManagedExcludeSegments } from './managed-paths.js';

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

type CompiledPattern =
  | { kind: 'segment'; value: string }
  | { kind: 'basename-literal'; value: string }
  | { kind: 'basename-glob'; regex: RegExp }
  | { kind: 'path-glob'; regex: RegExp };

function compile(raw: string): CompiledPattern {
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('**/')) {
    const base = p.slice(3);
    if (!base.includes('*') && !base.includes('?')) {
      return { kind: 'basename-literal', value: base };
    }
    return { kind: 'basename-glob', regex: globToRegex(base) };
  }
  if (!p.includes('/') && !p.includes('*') && !p.includes('?')) {
    return { kind: 'segment', value: p };
  }
  return { kind: 'path-glob', regex: globToRegex(p) };
}

/**
 * Build a matcher closure that compiles each pattern once. Hot-path callers
 * (the scanner walks ~10k files × ~10 patterns) should reuse a single matcher
 * across the walk so regex construction and pattern classification happen at
 * setup, not per-file.
 */
export function createExcludeMatcher(patterns: string[]): (relPath: string) => boolean {
  const compiled = patterns.map(compile);
  return (relPath) => {
    const normalized = relPath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const basename = segments[segments.length - 1] ?? normalized;
    for (const c of compiled) {
      switch (c.kind) {
        case 'segment':
          if (segments.includes(c.value)) return true;
          break;
        case 'basename-literal':
          if (basename === c.value) return true;
          break;
        case 'basename-glob':
          if (c.regex.test(basename)) return true;
          break;
        case 'path-glob':
          if (c.regex.test(normalized)) return true;
          break;
      }
    }
    return false;
  };
}

/** One-shot check; for repeated calls prefer `createExcludeMatcher`. */
export function isExcluded(relPath: string, patterns: string[]): boolean {
  return createExcludeMatcher(patterns)(relPath);
}

export interface ExcludeMatcherConfig {
  /** Absolute project root, used to read `.gitignore`. */
  projectRoot: string;
  /** Patterns from `canopy.exclude.patterns` — the user-custom layer. */
  userPatterns: string[];
}

/**
 * Build the three-layer scanner matcher. Composition is checked in order
 * but every layer is consulted (we don't short-circuit between layers
 * because all three are cheap closures). Each layer is compiled exactly
 * once at construction time so the hot walk path stays O(rules) per file.
 *
 * Note on the `isDir` argument: `walkProject` calls the matcher both for
 * directory entries (where it enables pruning the walk) and for files.
 * The gitignore layer needs `isDir` to honor trailing-slash dir-only
 * rules; the other layers ignore it. Defaulting to `false` keeps callers
 * that don't have the dirness handy (e.g. one-shot checks) working.
 */
export function createLayeredExcludeMatcher(
  config: ExcludeMatcherConfig,
): (relPath: string, isDir?: boolean) => boolean {
  const gitignore = loadProjectGitignoreMatcher(config.projectRoot);
  const managedSegments = new Set(getManagedExcludeSegments());
  const userMatcher = createExcludeMatcher(config.userPatterns);

  return (relPath, isDir = false) => {
    const normalized = relPath.replace(/\\/g, '/');
    if (gitignore(normalized, isDir)) return true;
    // Managed layer: any path segment that names a managed dir excludes
    // the entry. Cheap O(segments) check; no regex needed.
    for (const seg of normalized.split('/')) {
      if (managedSegments.has(seg)) return true;
    }
    if (userMatcher(normalized)) return true;
    return false;
  };
}
