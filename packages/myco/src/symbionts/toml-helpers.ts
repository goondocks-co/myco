/** TOML section header pattern. */
const TOML_SECTION_RE = /^\[([^\]]+)\]/;

/**
 * Find where a named TOML section ends.
 *
 * Walks forward from `searchStart` until it hits a section header that is
 * NEITHER the named section itself NOR any of its subtables (headers that
 * start with `${sectionName}.`). Returns `raw.length` if the section extends
 * to the end of the file.
 */
export function findTomlSectionEnd(
  raw: string,
  searchStart: number,
  sectionName: string,
): number {
  const subsectionPrefix = `${sectionName}.`;
  const rawLines = raw.slice(searchStart).split('\n');
  let offset = searchStart;
  for (const line of rawLines) {
    offset += line.length + 1;
    const m = line.match(TOML_SECTION_RE);
    if (m && !m[1].startsWith(subsectionPrefix) && m[1] !== sectionName) {
      return offset - line.length - 1;
    }
  }
  return raw.length;
}

/** Format a single TOML key = value line from a JS value. Skips unsupported types. */
function formatTomlScalarLine(key: string, val: unknown): string | null {
  if (typeof val === 'string') return `${key} = "${val}"`;
  if (typeof val === 'boolean') return `${key} = ${val}`;
  if (typeof val === 'number' && Number.isFinite(val)) return `${key} = ${val}`;
  if (Array.isArray(val)) {
    return `${key} = [${val.map((v: unknown) => `"${v}"`).join(', ')}]`;
  }
  return null;
}

/**
 * Insert or replace a top-level TOML section with the given scalar key/value pairs.
 *
 * - Scalar values (string, boolean, number, string[]) are written as `key = value`.
 * - Nested objects are ignored — use {@link buildTomlMcpSection} or call
 *   `upsertTomlSection` once per subtable if you need nested tables.
 * - Idempotent: running twice with the same inputs produces identical output.
 * - Preserves content before and after the section.
 */
export function upsertTomlSection(
  raw: string,
  sectionName: string,
  values: Record<string, unknown>,
): string {
  const sectionHeader = `[${sectionName}]`;

  const lines: string[] = [sectionHeader];
  for (const [key, val] of Object.entries(values)) {
    const line = formatTomlScalarLine(key, val);
    if (line !== null) lines.push(line);
  }
  const block = lines.join('\n');

  if (raw.includes(sectionHeader)) {
    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, sectionName);
    const before = raw.slice(0, startIdx).trimEnd();
    // findTomlSectionEnd returns the index of the next section header;
    // the slice starts with `[...]`. Normalize so the concatenation
    // always inserts a blank line between the rewritten block and the
    // following section header — without this, a section whose body
    // ends without a trailing newline (a one-liner like `hooks = true`)
    // collides with the next `[section]` and produces malformed TOML
    // like `hooks = true[notice.model_migrations]`.
    const after = raw.slice(endIdx).replace(/^\s+/, '');
    const beforeSeparator = before ? '\n\n' : '';
    const afterSeparator = after ? '\n\n' : '';
    return (before + beforeSeparator + block + afterSeparator + after).trimEnd() + '\n';
  }

  const separator = raw.trim() ? '\n\n' : '';
  return (raw.trimEnd() + separator + block).trimEnd() + '\n';
}

/**
 * Insert or update only the listed keys in a top-level TOML section, leaving
 * any other keys already in that section intact.
 *
 * Differs from {@link upsertTomlSection} which replaces the whole section
 * body. Use this when the caller owns a *subset* of the section's keys and
 * must coexist with user-owned siblings (e.g. Codex's `[features]` section,
 * where Myco owns `hooks` but the user may add other feature flags).
 *
 * - Scalar values (string, boolean, number, string[]) are written as `key = value`.
 * - Subtables (`[section.sub]`) below the named section are preserved.
 * - Idempotent.
 */
export function upsertTomlSectionKeys(
  raw: string,
  sectionName: string,
  values: Record<string, unknown>,
): string {
  const sectionHeader = `[${sectionName}]`;
  const writeEntries = Object.entries(values)
    .map(([key, val]) => ({ key, line: formatTomlScalarLine(key, val) }))
    .filter((e): e is { key: string; line: string } => e.line !== null);

  if (writeEntries.length === 0) return raw;

  if (!raw.includes(sectionHeader)) {
    const separator = raw.trim() ? '\n\n' : '';
    const block = [sectionHeader, ...writeEntries.map((e) => e.line)].join('\n');
    return (raw.trimEnd() + separator + block).trimEnd() + '\n';
  }

  const startIdx = raw.indexOf(sectionHeader);
  const bodyStart = startIdx + sectionHeader.length;
  const endIdx = findTomlSectionEnd(raw, bodyStart, sectionName);
  const sectionBody = raw.slice(bodyStart, endIdx);

  const bodyLines = sectionBody.split('\n');
  const writeMap = new Map(writeEntries.map((e) => [e.key, e.line]));
  const written = new Set<string>();
  const updatedLines: string[] = [];
  let subtableSeen = false;
  const subtableLines: string[] = [];

  for (const line of bodyLines) {
    if (subtableSeen || TOML_SECTION_RE.test(line.trim())) {
      subtableSeen = true;
      subtableLines.push(line);
      continue;
    }
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (m && writeMap.has(m[1])) {
      updatedLines.push(writeMap.get(m[1])!);
      written.add(m[1]);
      continue;
    }
    updatedLines.push(line);
  }

  // Append any template keys that didn't already exist in the section body.
  const trailing: string[] = [];
  for (const { key, line } of writeEntries) {
    if (!written.has(key)) trailing.push(line);
  }

  let mergedBody = updatedLines.join('\n');
  if (trailing.length > 0) {
    // Strip any pure-blank tail before splicing in the new keys so the
    // section stays compact (one blank line between body and subtables).
    mergedBody = mergedBody.replace(/\n*$/, '');
    mergedBody = (mergedBody ? mergedBody + '\n' : '') + trailing.join('\n');
  }
  const subtablePart = subtableLines.length > 0 ? '\n\n' + subtableLines.join('\n').replace(/^\s+/, '') : '';

  const before = raw.slice(0, startIdx).trimEnd();
  const after = raw.slice(endIdx).replace(/^\s+/, '');
  const beforeSeparator = before ? '\n\n' : '';
  const afterSeparator = after ? '\n\n' : '';

  const rebuiltSection = sectionHeader + (mergedBody.startsWith('\n') ? mergedBody : '\n' + mergedBody) + subtablePart;
  return (before + beforeSeparator + rebuiltSection + afterSeparator + after).trimEnd() + '\n';
}

/**
 * Read the scalar value of a single key inside a top-level TOML section.
 * Returns `undefined` if the section or key is absent. Booleans, integers,
 * and quoted strings are decoded; anything else (arrays, nested tables) is
 * returned as its raw RHS text so callers can value-compare.
 */
export function readTomlSectionKey(
  raw: string,
  sectionName: string,
  key: string,
): string | boolean | number | undefined {
  const sectionHeader = `[${sectionName}]`;
  if (!raw.includes(sectionHeader)) return undefined;

  const startIdx = raw.indexOf(sectionHeader);
  const bodyStart = startIdx + sectionHeader.length;
  const endIdx = findTomlSectionEnd(raw, bodyStart, sectionName);
  const body = raw.slice(bodyStart, endIdx);

  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
  for (const line of body.split('\n')) {
    if (TOML_SECTION_RE.test(line.trim())) break; // entered a subtable
    const m = line.match(keyRe);
    if (!m) continue;
    const rhs = m[1].replace(/\s*#.*$/, '').trim();
    if (rhs === 'true') return true;
    if (rhs === 'false') return false;
    if (/^-?\d+$/.test(rhs)) return Number(rhs);
    if (/^-?\d*\.\d+$/.test(rhs)) return Number(rhs);
    if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) {
      return rhs.slice(1, -1);
    }
    return rhs;
  }
  return undefined;
}

/**
 * Remove specific keys from a top-level TOML section.
 *
 * - Only the listed keys are removed. Other keys in the section are preserved.
 * - If the section ends up with no content after removal, the whole section
 *   (header and body) is stripped.
 * - Returns the updated string; equal to the input if no changes were made.
 */
export function removeTomlSectionKeys(
  raw: string,
  sectionName: string,
  keys: string[],
): string {
  const sectionHeader = `[${sectionName}]`;
  if (!raw.includes(sectionHeader)) return raw;

  const startIdx = raw.indexOf(sectionHeader);
  const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, sectionName);
  const sectionBody = raw.slice(startIdx + sectionHeader.length, endIdx);

  const keyRes = keys.map((k) => new RegExp(`^\\s*${escapeRegExp(k)}\\s*=`));
  const bodyLines = sectionBody.split('\n');
  const kept: string[] = [];
  let removedAny = false;
  let subtableSeen = false;
  for (const line of bodyLines) {
    // Once we hit a subtable header, everything after stays (keys belong to the parent)
    if (subtableSeen || TOML_SECTION_RE.test(line.trim())) {
      subtableSeen = true;
      kept.push(line);
      continue;
    }
    if (keyRes.some((re) => re.test(line))) {
      removedAny = true;
      continue;
    }
    kept.push(line);
  }
  if (!removedAny) return raw;

  // Determine whether the parent section still has any key = value lines.
  const hasRemainingKeys = kept.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    if (TOML_SECTION_RE.test(trimmed)) return false;
    return /=/.test(trimmed);
  });

  const before = raw.slice(0, startIdx).trimEnd();
  let rebuilt: string;
  if (hasRemainingKeys) {
    const newBody = kept.join('\n');
    const separator = before ? '\n\n' : '';
    rebuilt = before + separator + sectionHeader + newBody;
  } else {
    // Drop the header entirely; keep any trailing subtables we preserved above.
    const trailing = kept.join('\n').trimStart();
    const separator = before && trailing ? '\n\n' : '';
    rebuilt = before + separator + trailing;
  }
  return rebuilt.trimEnd() + (rebuilt.trim() ? '\n' : '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build/update a specific mcp_servers entry in a TOML string.
 * Pure transformation — returns updated content without writing to disk.
 *
 * Handles the MCP-specific `env` subtable pattern; for plain sections use
 * {@link upsertTomlSection}.
 */
export function buildTomlMcpSection(
  raw: string,
  serverName: string,
  server: Record<string, unknown>,
): string {
  const sectionName = `mcp_servers.${serverName}`;
  const sectionHeader = `[${sectionName}]`;

  // Build the TOML block for this server
  const lines: string[] = [sectionHeader];
  for (const [key, val] of Object.entries(server)) {
    if (key === 'env' && typeof val === 'object' && val !== null) continue; // Handle env as subtable
    const line = formatTomlScalarLine(key, val);
    if (line !== null) lines.push(line);
  }

  // Add env subtable if present
  const env = server.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    lines.push('');
    lines.push(`[${sectionName}.env]`);
    for (const [key, val] of Object.entries(env)) {
      lines.push(`${key} = "${val}"`);
    }
  }

  const block = lines.join('\n');

  let updated: string;
  if (raw.includes(sectionHeader)) {
    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, sectionName);
    const before = raw.slice(0, startIdx).trimEnd();
    // findTomlSectionEnd returns the offset of the next section header. Strip
    // leading whitespace from `after` and insert an explicit blank line between
    // our rewritten block and that header — otherwise a block whose final line
    // lacks a trailing newline (the common case here: lines.join('\n') leaves
    // none) collides with the following `[mcp_servers.x]` and writes invalid
    // TOML like `url = "..."[mcp_servers.node_repl]`. Same normalization as
    // upsertTomlSection.
    const after = raw.slice(endIdx).replace(/^\s+/, '');
    const beforeSeparator = before ? '\n\n' : '';
    const afterSeparator = after ? '\n\n' : '';
    updated = (before + beforeSeparator + block + afterSeparator + after).trimEnd() + '\n';
  } else {
    // Append new section
    const separator = raw.trim() ? '\n\n' : '';
    updated = (raw.trimEnd() + separator + block).trimEnd() + '\n';
  }

  return updated;
}
