import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard: stdio symbiont MCP templates must use committed,
 * project-portable launchers (no absolute paths, no `myco-dev`, no
 * host-specific shims). Most agents use the global `myco-run` launcher,
 * which consults `.myco/runtime.command` to pick the right binary per
 * project. OpenCode uses the committed project launcher because its MCP
 * child PATH can bypass `~/.local/bin`.
 *
 * Two shape variants are allowed:
 *   - Claude/Cursor/Gemini/Copilot: `{ command: "myco-run", args: ["mcp"] }`
 *   - Opencode:                     `{ command: ["node", ".agents/myco-cli.cjs", "mcp"] }`
 *   - Codex:                        `{ url: "http://127.0.0.1:{{daemonPort}}/mcp" }`
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
        if (name === 'codex') {
          expect(mycoServer.url).toBe('http://127.0.0.1:{{daemonPort}}/mcp');
          expect(mycoServer.command).toBeUndefined();
          expect(mycoServer.args).toBeUndefined();
          return;
        }

        const { command, args } = extractLauncherInvocation(mycoServer);

        if (name === 'opencode') {
          expect(command).toBe('node');
          expect(args).toEqual(['.agents/myco-cli.cjs', 'mcp']);
        } else {
          expect(command).toBe('myco-run');
          expect(args[0]).toBe('mcp');
        }

        // Hard guards against the failure modes we've already seen.
        for (const token of [command, ...args]) {
          expect(token).not.toMatch(/^\//);
          expect(token).not.toContain('/Users/');
          expect(token).not.toBe('myco-dev');
        }
        expect(command).not.toBe('myco');
      });
    });
  }
});
