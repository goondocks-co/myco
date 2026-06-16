import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard: every symbiont MCP template must be a stdio launcher.
 *
 * No symbiont ships a bare-HTTP-URL MCP template — those can't carry
 * per-project tenancy to the global daemon (the URL has no notion of the
 * workspace cwd, so every project would collapse onto one tenant). The
 * stdio launcher `myco-run mcp` spawns at the workspace cwd, so the bridge
 * resolves the project tenancy. cli-transport symbionts (codex, cursor,
 * windsurf, antigravity) therefore have NO mcp template at all and reach
 * Myco through the CLI instead; only mcp-transport symbionts ship one.
 *
 * Shape variants allowed (both stdio):
 *   - Stdio bin:   `{ command: "{{mycoBinary}}", args: ["mcp"] }`
 *                  Claude Code, Copilot — the stdio bridge `<binary> mcp`
 *                  spawns at the workspace cwd, so the bridge resolves the
 *                  project tenancy.
 *   - Local array: `{ type: "local", command: ["{{mycoBinary}}", "mcp"] }`
 *                  OpenCode's local-MCP schema (command is an ARRAY).
 *
 * The launcher is the `{{mycoBinary}}` placeholder, substituted at install time
 * with the resolved self-contained binary path (the same resolution hooks use)
 * so a native Windows agent with no node on PATH can spawn the bridge. Any
 * `url`/`serverUrl`-shaped template is hard-rejected (guards the #355 stdio→HTTP
 * regression). The retired `myco-run` node shim, the `["node",
 * ".agents/myco-cli.cjs", "mcp"]` project-launcher shape, and the raw
 * `myco`/`myco-dev` binaries are hard-rejected below.
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
  serverUrl?: string;
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

      it('uses a stdio launcher shape — never a bare HTTP URL', () => {
        // A bare HTTP/URL transport can't carry per-project tenancy to the
        // global daemon; every shipped MCP template must be a stdio
        // launcher. Reject any `url`/`serverUrl` shape outright.
        expect(mycoServer.url).toBeUndefined();
        expect(mycoServer.serverUrl).toBeUndefined();

        // Stdio transport: the committed template carries the
        // `{{mycoBinary}}` placeholder, substituted at install time with the
        // resolved binary path. Both the bin shape
        // (`command: "{{mycoBinary}}"`, args `["mcp"]`) and OpenCode's
        // local-array shape (`command: ["{{mycoBinary}}", "mcp"]`) normalize
        // to the same launcher + first-arg here.
        const { command, args } = extractLauncherInvocation(mycoServer);
        expect(command).toBe('{{mycoBinary}}');
        expect(args[0]).toBe('mcp');

        // Hard guards against the failure modes we've already seen,
        // including the retired `myco-run` node shim and the
        // `.agents/myco-cli.cjs` project launcher. Templates are checked in
        // pre-substitution, so no absolute path should appear in the source.
        for (const token of [command, ...args]) {
          expect(token).not.toMatch(/^\//);
          expect(token).not.toContain('/Users/');
          expect(token).not.toBe('myco-dev');
          expect(token).not.toBe('myco-run');
          expect(token).not.toContain('myco-cli.cjs');
        }
        expect(command).not.toBe('node');
        expect(command).not.toBe('myco');
      });
    });
  }
});
