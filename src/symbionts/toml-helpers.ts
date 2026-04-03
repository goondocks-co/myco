/** TOML section header pattern. */
const TOML_SECTION_RE = /^\[([^\]]+)\]/;

/** Find where a [mcp_servers.<name>] section ends in a TOML string. */
export function findTomlSectionEnd(raw: string, searchStart: number, serverName: string): number {
  const subsectionPrefix = `mcp_servers.${serverName}.`;
  const rawLines = raw.slice(searchStart).split('\n');
  let offset = searchStart;
  for (const line of rawLines) {
    offset += line.length + 1;
    const m = line.match(TOML_SECTION_RE);
    if (m && !m[1].startsWith(subsectionPrefix) && m[1] !== `mcp_servers.${serverName}`) {
      return offset - line.length - 1;
    }
  }
  return raw.length;
}

/**
 * Build/update a specific mcp_servers entry in a TOML string.
 * Pure transformation — returns updated content without writing to disk.
 */
export function buildTomlMcpSection(
  raw: string,
  serverName: string,
  server: Record<string, unknown>,
): string {
  const sectionHeader = `[mcp_servers.${serverName}]`;

  // Build the TOML block for this server
  const lines: string[] = [sectionHeader];
  for (const [key, val] of Object.entries(server)) {
    if (key === 'env' && typeof val === 'object' && val !== null) continue; // Handle env as subtable
    if (typeof val === 'string') {
      lines.push(`${key} = "${val}"`);
    } else if (Array.isArray(val)) {
      lines.push(`${key} = [${val.map((v: unknown) => `"${v}"`).join(', ')}]`);
    } else if (typeof val === 'boolean') {
      lines.push(`${key} = ${val}`);
    }
  }

  // Add env subtable if present
  const env = server.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${serverName}.env]`);
    for (const [key, val] of Object.entries(env)) {
      lines.push(`${key} = "${val}"`);
    }
  }

  const block = lines.join('\n');

  let updated: string;
  if (raw.includes(sectionHeader)) {
    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, serverName);
    const before = raw.slice(0, startIdx).trimEnd();
    const after = raw.slice(endIdx);
    const separator = before ? '\n\n' : '';
    updated = (before + separator + block + after).trimEnd() + '\n';
  } else {
    // Append new section
    const separator = raw.trim() ? '\n\n' : '';
    updated = (raw.trimEnd() + separator + block).trimEnd() + '\n';
  }

  return updated;
}
