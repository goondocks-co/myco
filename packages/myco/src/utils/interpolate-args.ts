const TEMPLATE_RE = /^\s*\{\{\s*(.+?)\s*\}\}\s*$/;

export function interpolateArgs(
  args: Record<string, unknown>,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
    if (typeof raw !== 'string') {
      result[key] = raw;
      continue;
    }
    const match = raw.match(TEMPLATE_RE);
    if (!match) {
      result[key] = raw;
      continue;
    }
    const expr = match[1];
    const rendered = renderExpr(expr, vars);
    if (rendered !== null && rendered !== undefined) {
      result[key] = rendered;
    }
  }
  return result;
}

function renderExpr(expr: string, vars: Record<string, unknown>): unknown {
  const [pathPart, ...filterParts] = expr.split('|').map((s) => s.trim());
  const value = lookup(pathPart, vars);
  if (value !== undefined) return value;
  for (const filter of filterParts) {
    const defaultMatch = filter.match(/^default\((.*)\)$/);
    if (defaultMatch) return parseLiteral(defaultMatch[1].trim());
  }
  throw new Error(`interpolateArgs: unresolved variable "${expr}"`);
}

function lookup(path: string, vars: Record<string, unknown>): unknown {
  const parts = path.split('.').map((s) => s.trim()).filter(Boolean);
  let cursor: unknown = vars;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function parseLiteral(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  const quoted = raw.match(/^['"](.*)['"]$/);
  if (quoted) return quoted[1];
  throw new Error(`interpolateArgs: unsupported default literal "${raw}"`);
}
