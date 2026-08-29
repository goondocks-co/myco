/**
 * The member package carries two MCP SDK lines, each with a fixed set of
 * importers.
 *
 * The 2.0 line (`@modelcontextprotocol/client`, `@modelcontextprotocol/server`)
 * is the Deployment-facing side: the stdio bridge, the CLI tool client, and
 * the Deployment upstream they share — both ends of the bridge speak the
 * same line the Deployment serves. The 1.x line (`@modelcontextprotocol/sdk`)
 * is the local daemon's own MCP server and the surfaces built on it, which
 * #925 retires with the daemon. A file crossing from one list to the other
 * fails here by name; a new importer of either line is a reviewed act.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** The Deployment-facing files: the 2.0 line and nothing of the 1.x line. */
const MODERN_LINE = ['cli/tool.ts', 'mcp/deployment-upstream.ts', 'mcp/stdio-bridge.ts'];
/** The local-daemon files on the 1.x line, retired with the daemon (#925). */
const DAEMON_LINE = ['daemon/external-listener.ts', 'mcp/http.ts', 'mcp/server.ts'];

const MODERN = /^@modelcontextprotocol\/(client|server)(\/|$)/;
const LEGACY = /^@modelcontextprotocol\/sdk(\/|$)/;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const specifiers = (text: string): string[] => [...text.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2] ?? m[3]);

describe('MCP SDK lines in the member package', () => {
  const byFile = new Map<string, string[]>();
  for (const file of sources(SRC)) {
    const specs = specifiers(fs.readFileSync(file, 'utf8')).filter((s) => /^@modelcontextprotocol\//.test(s));
    if (specs.length > 0) byFile.set(path.relative(SRC, file), specs);
  }

  it('imports the 2.0 line from the Deployment-facing files alone, and none of the 1.x line there', () => {
    for (const file of MODERN_LINE) {
      const specs = byFile.get(file) ?? [];
      expect({ file, modern: specs.some((s) => MODERN.test(s)), legacy: specs.filter((s) => LEGACY.test(s)) }).toEqual({ file, modern: true, legacy: [] });
    }
  });

  it('imports the 1.x line from the local-daemon files alone, each named for its retirement', () => {
    const legacyImporters = [...byFile.entries()].filter(([, specs]) => specs.some((s) => LEGACY.test(s))).map(([file]) => file).sort();
    expect(legacyImporters).toEqual([...DAEMON_LINE].sort());
    const modernImporters = [...byFile.entries()].filter(([, specs]) => specs.some((s) => MODERN.test(s))).map(([file]) => file).sort();
    expect(modernImporters).toEqual([...MODERN_LINE].sort());
  });
});
