import YAML from 'yaml';

/**
 * YAML-frontmatter markdown parsing/serialization for OKF concept documents.
 *
 * Chosen over gray-matter to control alias limits (`maxAliasCount`), duplicate-key
 * rejection (`uniqueKeys`), and canonical key ordering on output. The `yaml` v2
 * core schema is safe by default (no code execution, no arbitrary tags); every
 * other bound below is our own post-parse check, not a library option.
 */

export interface ParsedConceptDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export class OkfFrontmatterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OkfFrontmatterError';
  }
}

/** Serialized frontmatter text bound (bytes). */
const MAX_FRONTMATTER_BYTES = 32 * 1024;
/** Body bound (bytes). */
const MAX_BODY_BYTES = 1024 * 1024;
/** Maximum container (map/array) nesting depth, counting the root mapping as 1. */
const MAX_CONTAINER_DEPTH = 6;
/** Maximum entries in any single array. */
const MAX_ARRAY_ENTRIES = 512;
/** Maximum size of any single string scalar (bytes). */
const MAX_SCALAR_BYTES = 8 * 1024;

/** Canonical leading key order for concept frontmatter; remaining keys keep insertion order. */
const CANONICAL_KEY_ORDER = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'] as const;

function enforceValueBounds(value: unknown, depth: number, keyPath: string): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_SCALAR_BYTES) {
      throw new OkfFrontmatterError(
        `scalar_too_large: frontmatter scalar at "${keyPath}" exceeds ${MAX_SCALAR_BYTES} bytes`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_CONTAINER_DEPTH) {
      throw new OkfFrontmatterError(
        `nesting_too_deep: frontmatter nesting at "${keyPath}" exceeds depth ${MAX_CONTAINER_DEPTH}`,
      );
    }
    if (value.length > MAX_ARRAY_ENTRIES) {
      throw new OkfFrontmatterError(
        `array_too_long: frontmatter array at "${keyPath}" exceeds ${MAX_ARRAY_ENTRIES} entries`,
      );
    }
    value.forEach((entry, i) => enforceValueBounds(entry, depth + 1, `${keyPath}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (depth > MAX_CONTAINER_DEPTH) {
      throw new OkfFrontmatterError(
        `nesting_too_deep: frontmatter nesting at "${keyPath}" exceeds depth ${MAX_CONTAINER_DEPTH}`,
      );
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      enforceValueBounds(v, depth + 1, keyPath ? `${keyPath}.${k}` : k);
    }
  }
}

function parseYamlMapping(yamlText: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = yamlText.trim() === '' ? {} : YAML.parse(yamlText, { maxAliasCount: 64, uniqueKeys: true });
  } catch (err) {
    throw new OkfFrontmatterError(
      `unparseable_frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OkfFrontmatterError('unparseable_frontmatter: frontmatter must be a YAML mapping');
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a `---` frontmatter markdown document into frontmatter + canonical body.
 *
 * Canonical body form: CRLF normalized to LF, the single blank separator line after
 * the closing delimiter stripped, and trailing newlines trimmed (serialization adds
 * back exactly one), so parse → serialize → parse is value-stable and serialization
 * of canonical input is byte-idempotent.
 *
 * Throws {@link OkfFrontmatterError} on a missing frontmatter block, unparseable
 * YAML, or any exceeded bound (frontmatter/body size, nesting depth, array length,
 * scalar size).
 */
export function parseConceptDoc(raw: string): ParsedConceptDoc {
  const src = raw.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) {
    throw new OkfFrontmatterError('missing_frontmatter: document must begin with a "---" frontmatter block');
  }
  let yamlText: string;
  let bodyRaw: string;
  const close = src.indexOf('\n---\n', 3);
  if (close !== -1) {
    yamlText = src.slice(4, close + 1);
    bodyRaw = src.slice(close + 5);
  } else if (src.endsWith('\n---')) {
    yamlText = src.slice(4, src.length - 3);
    bodyRaw = '';
  } else {
    throw new OkfFrontmatterError('missing_frontmatter: unterminated frontmatter block (no closing "---")');
  }

  if (Buffer.byteLength(yamlText, 'utf8') > MAX_FRONTMATTER_BYTES) {
    throw new OkfFrontmatterError(`frontmatter_too_large: frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`);
  }
  if (Buffer.byteLength(bodyRaw, 'utf8') > MAX_BODY_BYTES) {
    throw new OkfFrontmatterError(`body_too_large: body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const frontmatter = parseYamlMapping(yamlText);
  enforceValueBounds(frontmatter, 1, '');

  const body = bodyRaw.replace(/^\n/, '').replace(/\n+$/, '');
  return { frontmatter, body };
}

function orderKeys(
  frontmatter: Record<string, unknown>,
  keyOrder: 'canonical' | 'insertion',
): Record<string, unknown> {
  if (keyOrder === 'insertion') return { ...frontmatter };
  const out: Record<string, unknown> = {};
  for (const key of CANONICAL_KEY_ORDER) {
    if (key in frontmatter) out[key] = frontmatter[key];
  }
  for (const key of Object.keys(frontmatter)) {
    if (!(key in out)) out[key] = frontmatter[key];
  }
  return out;
}

/**
 * Serialize frontmatter + body to canonical `---` markdown: LF endings, exactly one
 * trailing newline, and (by default) canonical leading key order — `type`, `title`,
 * `description`, `resource`, `tags`, `timestamp`, then remaining keys in insertion
 * order. `keyOrder: 'insertion'` preserves the caller's order verbatim (root
 * `index.md` leads with `okf_version`).
 *
 * Deterministic: identical inputs produce identical bytes. Enforces the same value
 * bounds as {@link parseConceptDoc} so oversized content fails at the write boundary.
 */
export function serializeConceptDoc(
  frontmatter: Record<string, unknown>,
  body: string,
  opts?: { keyOrder?: 'canonical' | 'insertion' },
): string {
  enforceValueBounds(frontmatter, 1, '');
  const ordered = orderKeys(frontmatter, opts?.keyOrder ?? 'canonical');
  const yamlText = YAML.stringify(ordered, { lineWidth: 0 });
  if (Buffer.byteLength(yamlText, 'utf8') > MAX_FRONTMATTER_BYTES) {
    throw new OkfFrontmatterError(`frontmatter_too_large: frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`);
  }
  const canonicalBody = body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (Buffer.byteLength(canonicalBody, 'utf8') > MAX_BODY_BYTES) {
    throw new OkfFrontmatterError(`body_too_large: body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const head = `---\n${yamlText}---\n`;
  return canonicalBody === '' ? head : `${head}\n${canonicalBody}\n`;
}
