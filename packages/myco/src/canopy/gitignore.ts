// Minimal `.gitignore` matcher. We intentionally avoid the `ignore` npm
// package because it isn't already a transitive dep — pulling in a runtime
// dependency for what amounts to ~80 lines of glob-to-regex would be a
// regression. The implementation below covers the gitignore syntax surface
// we actually rely on: comments, blank lines, negation, anchored patterns,
// directory-only patterns, `**`, `*`, and `?`.
//
// LIMITATION: this reads only the project root's `.gitignore`. Nested
// `.gitignore` files inside subdirectories are ignored. A follow-up can
// teach the scanner to fold per-directory rules in if and when a project
// surfaces a real need; today everything we want to exclude is declared at
// the root.
import fs from 'node:fs';
import path from 'node:path';

interface CompiledRule {
  /** Negation (`!foo`) re-includes a previously excluded path. */
  negate: boolean;
  /** Pattern is anchored to the project root (leading `/` or contains `/`). */
  anchored: boolean;
  /** Pattern only matches directories (trailing `/`). */
  dirOnly: boolean;
  /** Compiled regex matched against the (anchored or basename) candidate. */
  regex: RegExp;
}

/** Compile one gitignore line into a rule, or null if the line is blank/comment. */
function compileRule(rawLine: string): CompiledRule | null {
  let line = rawLine.replace(/\r$/, '');
  // Trim trailing unescaped whitespace, per gitignore semantics.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (line.length === 0) return null;
  if (line.startsWith('#')) return null;

  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  // Per gitignore: a pattern with a slash (other than a trailing one) is
  // anchored to the directory containing the .gitignore. A leading slash also
  // anchors but doesn't itself appear in the matched path.
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }

  return { negate, anchored, dirOnly, regex: globToRegex(line) };
}

/** Translate a gitignore glob (sans negation/anchor markers) to a regex. */
function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      // `**/` → match zero or more path segments (including none).
      if (glob[i + 1] === '*' && glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
        continue;
      }
      // Trailing `**` → match anything remaining.
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        continue;
      }
      // Single `*` → match within a single path segment.
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Build the matcher from already-compiled rules. */
function buildMatcher(rules: CompiledRule[]): (relPath: string, isDir: boolean) => boolean {
  return (relPath, isDir) => {
    const normalized = relPath.replace(/\\/g, '/');
    let ignored = false;
    for (const rule of rules) {
      if (matchRule(rule, normalized, isDir)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}

/**
 * Match one compiled rule against a candidate path. The semantic mirrors
 * gitignore: a rule that hits an ancestor directory implicitly excludes
 * everything under it, so we walk every path-prefix and test the rule
 * against each segment-suffix (anchored at that prefix). Cheap because
 * most paths have only a handful of segments.
 */
function matchRule(rule: CompiledRule, normalized: string, isDir: boolean): boolean {
  const segments = normalized.split('/');
  // Walk every prefix length k=1..N. The prefix represents either an
  // ancestor directory (if k<N) or the path itself (k=N). When the prefix
  // is an ancestor, it's a directory, so dir-only rules apply there too.
  for (let k = 1; k <= segments.length; k++) {
    const prefix = segments.slice(0, k).join('/');
    const isPrefixDir = k < segments.length || isDir;
    if (rule.dirOnly && !isPrefixDir) continue;
    if (rule.anchored) {
      if (rule.regex.test(prefix)) return true;
      continue;
    }
    // Unanchored: test every suffix of the prefix so the rule matches at
    // any depth (e.g. `node_modules` hits `a/node_modules` via the
    // `node_modules` suffix).
    for (let i = 0; i < k; i++) {
      const candidate = segments.slice(i, k).join('/');
      if (rule.regex.test(candidate)) return true;
    }
  }
  return false;
}

/**
 * Compile `.gitignore` content into a matcher. The matcher returns `true`
 * when the path should be ignored (matches gitignore semantics). Negations
 * apply only within this matcher — callers compose multiple layers
 * separately.
 */
export function createGitignoreMatcher(content: string): (relPath: string, isDir: boolean) => boolean {
  const rules: CompiledRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = compileRule(line);
    if (rule) rules.push(rule);
  }
  return buildMatcher(rules);
}

/**
 * Read `<projectRoot>/.gitignore` and return a matcher. Returns a no-op
 * matcher when the file is missing or unreadable so a project without a
 * `.gitignore` still scans cleanly under the layered matcher.
 */
export function loadProjectGitignoreMatcher(projectRoot: string): (relPath: string, isDir: boolean) => boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    return createGitignoreMatcher(content);
  } catch {
    return () => false;
  }
}
