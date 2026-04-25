import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

const TOP_COMMENT_MAX = 240;

/**
 * Mechanical regex parser for `.py` files. Captures the module-level
 * docstring (triple-quoted at column zero, possibly preceded by shebang or
 * blank lines), top-level `def`/`class` names, and `import`/`from` modules.
 */
export const pythonParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  return {
    language: 'python',
    exports: extractDefsAndClasses(input.content),
    imports: extractImports(input.content),
    topComment: extractDocstring(input.content),
  };
};

function extractDocstring(content: string): string | null {
  // Skip leading shebang, encoding cookie, and blank lines.
  let idx = 0;
  while (idx < content.length) {
    const nl = content.indexOf('\n', idx);
    const line = (nl === -1 ? content.slice(idx) : content.slice(idx, nl)).trimEnd();
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('#')) {
      if (nl === -1) return null;
      idx = nl + 1;
      continue;
    }
    break;
  }
  const head = content.slice(idx);
  const m = head.match(/^([ru]?)("""|''')([\s\S]*?)\2/i);
  if (!m) return null;
  const body = m[3].trim().replace(/\s+/g, ' ');
  return body.length === 0 ? null : body.slice(0, TOP_COMMENT_MAX);
}

function extractDefsAndClasses(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    // Top-level only — no leading whitespace.
    const m = line.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (m) {
      out.push(m[1]);
      continue;
    }
    const c = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (c) out.push(c[1]);
  }
  return out;
}

function extractImports(content: string): string[] {
  const set = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const f = line.match(/^from\s+([.\w]+)\s+import\b/);
    if (f) {
      set.add(f[1]);
      continue;
    }
    const i = line.match(/^import\s+(.+?)(?:\s+as\s+\w+)?\s*$/);
    if (i) {
      for (const part of i[1].split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name) set.add(name);
      }
    }
  }
  return [...set];
}
