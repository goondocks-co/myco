import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard: symbiont MCP templates must use a portable transport
 * shape — either an HTTP URL pointing at the local daemon, or a stdio
 * launcher invocation with no absolute paths and no `myco-dev` shim.
 *
 * Shape variants allowed:
 *   - HTTP URL:    `{ url: "http://127.0.0.1:{{daemonPort}}/mcp" }`
 *                  Codex's MCP surface and any other URL-transport agent.
 *   - Stdio bin:   `{ command: "myco-run", args: ["mcp"] }`
 *                  Claude Code, Copilot — the stdio bridge `myco-run mcp`
 *                  spawns at the workspace cwd, so the bridge resolves the
 *                  project tenancy.
 *   - Local array: `{ type: "local", command: ["myco-run", "mcp"] }`
 *                  OpenCode's local-MCP schema (command is an ARRAY).
 *
 * The launcher is `myco-run` (PATH binary). The retired
 * `["node", ".agents/myco-cli.cjs", "mcp"]` project-launcher shape and the
 * raw `myco`/`myco-dev` binaries are hard-rejected below.
 */

const TEMPLATES_ROOT = path.resolve('packages/myco/src/symbionts/templates');

function listMcpTemplates(): string[] {
  const entries: string[] = [];
  for (const dirName of fs.readdirSync(TEMPLATES_ROOT, { withFileTypes: true })) {
    if (!dirName.isDirectory()) continue;
    const candidate = path.join(TEMPLATES_ROOT, dirName.name, 'mcp.json');
    if (fs.existsSync(candidate)) entries.push(candidate);
  }
  return entries;
}

interface Server {
  command?: string | string[];
  args?: string[];
  url?: string;
}

function extractLauncherInvocation(server: Server): { command: string; args: string[] } {
  if (Array.isArray(server.command)) {
    const [command, ...args] = server.command;
    return { command, args };
  }
  return { command: server.command ?? '', args: server.args ?? [] };
}

describe('symbiont MCP templates', () => {
  const templatePaths = listMcpTemplates();

  it('found at least one MCP template to validate', () => {
    expect(templatePaths.length).toBeGreaterThan(0);
  });

  for (const templatePath of templatePaths) {
    const name = path.basename(path.dirname(templatePath));

    describe(`${name}/mcp.json`, () => {
      const raw = fs.readFileSync(templatePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, Server>;
      const mycoServer = parsed.myco;

      it('declares a `myco` MCP server', () => {
        expect(mycoServer).toBeDefined();
      });

      it('uses the expected transport shape', () => {
        // URL transport: every URL must point at the local daemon via the
        // `{{daemonPort}}` placeholder. Windsurf uses `serverUrl` (its
        // MCP config key), every other URL-transport agent uses `url`.
        const url = (mycoServer as { url?: string; serverUrl?: string }).url
          ?? (mycoServer as { url?: string; serverUrl?: string }).serverUrl;
        if (url) {
          expect(url).toBe('http://127.0.0.1:{{daemonPort}}/mcp');
          expect(mycoServer.command).toBeUndefined();
          expect(mycoServer.args).toBeUndefined();
          return;
        }

        // Stdio transport: launcher invocation must use a portable
        // command (no absolute paths, no host-specific shims). Both the
        // bin shape (`command: "myco-run"`, args `["mcp"]`) and OpenCode's
        // local-array shape (`command: ["myco-run", "mcp"]`) normalize to
        // the same launcher + first-arg here.
        const { command, args } = extractLauncherInvocation(mycoServer);
        expect(command).toBe('myco-run');
        expect(args[0]).toBe('mcp');

        // Hard guards against the failure modes we've already seen,
        // including the retired `.agents/myco-cli.cjs` project launcher.
        for (const token of [command, ...args]) {
          expect(token).not.toMatch(/^\//);
          expect(token).not.toContain('/Users/');
          expect(token).not.toBe('myco-dev');
          expect(token).not.toContain('myco-cli.cjs');
        }
        expect(command).not.toBe('node');
        expect(command).not.toBe('myco');
      });
    });
  }
});
