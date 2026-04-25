// Minimal glob matcher for Canopy exclude patterns. We avoid the minimatch dep
// because the default pattern set only needs three shapes: bare segment,
// `**/<basename>`, and `**/<glob>` against the basename.

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

function matchesBasename(relPath: string, basenameGlob: string): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  if (!basenameGlob.includes('*') && !basenameGlob.includes('?')) {
    return base === basenameGlob;
  }
  return globToRegex(basenameGlob).test(base);
}

function matchesAnySegment(relPath: string, segment: string): boolean {
  return relPath.split('/').some((part) => part === segment);
}

export function isExcluded(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  for (const raw of patterns) {
    const p = raw.replace(/\\/g, '/');
    if (p.startsWith('**/')) {
      if (matchesBasename(normalized, p.slice(3))) return true;
      continue;
    }
    if (!p.includes('/') && !p.includes('*') && !p.includes('?')) {
      if (matchesAnySegment(normalized, p)) return true;
      continue;
    }
    // Fallback: treat as path-shape glob anchored at start.
    if (globToRegex(p).test(normalized)) return true;
  }
  return false;
}
