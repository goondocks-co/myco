// Minimal glob matcher for Canopy exclude patterns. We avoid the minimatch dep
// because the default pattern set only needs three shapes: bare segment,
// `**/<basename>`, and `**/<glob>` against the basename.

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
