// `.gitignore` matcher with nested-file support. We intentionally avoid the
// `ignore` npm package because it isn't already a transitive dep — pulling
// in a runtime dependency for ~150 lines of glob-to-regex would be a
// regression. The implementation below covers the gitignore syntax surface
// we actually rely on: comments, blank lines, negation, anchored patterns,
// directory-only patterns, `**`, `*`, and `?`.
//
// Nested `.gitignore` semantics (matches git):
//   - A `.gitignore` file in directory D applies to paths under D.
//   - Its rules are anchored relative to D (so `/foo` means `D/foo`).
//   - Inner gitignores override outer ones (they are "read later").
//   - An ignored directory's `.gitignore` is NOT consulted for paths
//     inside it — git doesn't read it. This matters for matcher callers
//     that aren't going through the walker (rescanSingle, migration).
import fs from 'node:fs';
import path from 'node:path';

interface CompiledRule {
  /** Negation (`!foo`) re-includes a previously excluded path. */
  negate: boolean;
  /** Pattern is anchored to the rule's owning directory. */
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
  // anchored to the directory containing the .gitignore. A leading slash
  // also anchors but doesn't itself appear in the matched path.
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

/**
 * Match one compiled rule against a candidate path. The candidate is
 * already scoped to the rule's owning directory (i.e., relative to that
 * directory). Walks every path-prefix so unanchored rules match at any
 * depth (`node_modules` hits `a/node_modules`).
 */
function matchRule(rule: CompiledRule, scopedPath: string, isDir: boolean): boolean {
  const segments = scopedPath.split('/');
  for (let k = 1; k <= segments.length; k++) {
    const prefix = segments.slice(0, k).join('/');
    const isPrefixDir = k < segments.length || isDir;
    if (rule.dirOnly && !isPrefixDir) continue;
    if (rule.anchored) {
      if (rule.regex.test(prefix)) return true;
      continue;
    }
    for (let i = 0; i < k; i++) {
      const candidate = segments.slice(i, k).join('/');
      if (rule.regex.test(candidate)) return true;
    }
  }
  return false;
}

/** Compile gitignore content into a rule list. */
function compileRules(content: string): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = compileRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Compile flat gitignore content into a matcher (no nested-file support).
 * Kept exported for tests and callers that have content in hand and don't
 * need walk-time nested-gitignore semantics.
 */
export function createGitignoreMatcher(content: string): (relPath: string, isDir: boolean) => boolean {
  const rules = compileRules(content);
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
 * Build a matcher that honors `.gitignore` files at every depth in the
 * project. Rules in deeper `.gitignore`s override outer ones (they are
 * "read later"); a `.gitignore` inside an already-ignored directory is
 * not consulted, matching git's behavior.
 *
 * The returned matcher is stateful only via two internal caches —
 * `rulesByDir` (file content → compiled rules) and `dirIgnoredCache`
 * (directory → ignored?). Both are scoped to a single matcher instance,
 * so a fresh scan starts with a clean cache.
 */
export function loadProjectGitignoreMatcher(projectRoot: string): (relPath: string, isDir: boolean) => boolean {
  const rulesByDir = new Map<string, CompiledRule[]>();
  const dirIgnoredCache = new Map<string, boolean>();

  function rulesForDir(dirRel: string): CompiledRule[] {
    const cached = rulesByDir.get(dirRel);
    if (cached !== undefined) return cached;
    let rules: CompiledRule[] = [];
    try {
      const filePath = path.join(projectRoot, dirRel, '.gitignore');
      const content = fs.readFileSync(filePath, 'utf-8');
      rules = compileRules(content);
    } catch {
      // Missing or unreadable .gitignore → no rules at this scope.
    }
    rulesByDir.set(dirRel, rules);
    return rules;
  }

  function isPathIgnored(normalized: string, isDir: boolean): boolean {
    const segments = normalized.split('/');
    let ignored = false;
    // Walk scopes outermost-first: '', 'a', 'a/b', ... up to the parent
    // directory of the candidate path. Each scope's `.gitignore` (if any)
    // is read once and applied to the path scoped relative to that dir.
    for (let depth = 0; depth < segments.length; depth++) {
      const scopeDir = segments.slice(0, depth).join('/');
      // Inside an ignored directory, git doesn't consult the nested
      // `.gitignore`. Skip its rules so a rogue `!foo` can't re-include
      // paths that an outer rule already banned.
      if (depth > 0 && isDirIgnored(scopeDir)) continue;
      const rules = rulesForDir(scopeDir);
      if (rules.length === 0) continue;
      const scopedPath = segments.slice(depth).join('/');
      for (const rule of rules) {
        if (matchRule(rule, scopedPath, isDir)) {
          ignored = !rule.negate;
        }
      }
    }
    return ignored;
  }

  function isDirIgnored(dirRel: string): boolean {
    if (dirRel === '') return false;
    const cached = dirIgnoredCache.get(dirRel);
    if (cached !== undefined) return cached;
    const result = isPathIgnored(dirRel, true);
    dirIgnoredCache.set(dirRel, result);
    return result;
  }

  return (relPath, isDir) => {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized === '') return false;
    return isPathIgnored(normalized, isDir);
  };
}
