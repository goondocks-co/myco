import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard: every symbiont MCP template must invoke `myco-run`
 * (no absolute paths, no `myco-dev`, no host-specific shims). The
 * global `myco-run` launcher consults `.myco/runtime.command` to pick
 * the right binary per project, so pinning anything else in a committed
 * template breaks either prod users (if we pin `myco-dev`) or the repo
 * (if we pin an absolute path that leaks a username).
 *
 * Two shape variants are allowed:
 *   - Claude/Cursor/Codex/Gemini/Copilot: `{ command: "myco-run", args: ["mcp"] }`
 *   - Opencode:                           `{ command: ["myco-run", "mcp"] }`
 *
 * Both satisfy "the launcher command is literally `myco-run mcp`."
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

      it('invokes exactly `myco-run mcp` (no absolute paths, no dev-specific binaries)', () => {
        const { command, args } = extractLauncherInvocation(mycoServer);

        // Rationale for each assertion:
        //  - command === 'myco-run': the launcher must be PATH-resolved
        //    so .myco/runtime.command can intercept. Pinning `myco-dev`
        //    breaks prod; pinning an absolute path (`/Users/<name>/…`)
        //    leaks a username into the committed template.
        //  - args/start === ['mcp']: the launcher expects `mcp` as the
        //    first forwarded argument.
        expect(command).toBe('myco-run');
        expect(args[0]).toBe('mcp');

        // Hard guards against the failure modes we've already seen.
        expect(command).not.toMatch(/^\//);
        expect(command).not.toBe('myco-dev');
        expect(command).not.toBe('myco');
      });
    });
  }
});
