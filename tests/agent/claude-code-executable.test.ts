import { describe, expect, it } from 'bun:test';
import { resolveClaudeCodeExecutable } from '@myco/agent/runtime/claude-code-executable.js';

describe('resolveClaudeCodeExecutable', () => {
  it('resolves the optional CLI package from the installed package root on disk', () => {
    const calls: string[] = [];
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: 'file:///Users/chris/Repos/myco/packages/myco/src/agent/runtime/claude-code-executable.ts',
      execPath: '/opt/homebrew/lib/node_modules/@goondocks/myco/vendor/darwin-arm64/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: (value) => value === '/opt/homebrew/lib/node_modules/@goondocks/myco/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      requireFactory: (_from) => ({
        resolve(specifier: string) {
          calls.push(specifier);
          if (specifier === '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json') {
            return '/opt/homebrew/lib/node_modules/@goondocks/myco/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json';
          }
          throw new Error(`Cannot resolve ${specifier}`);
        },
      }) as NodeJS.Require,
    });

    expect(calls).toContain('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json');
    expect(executable).toBe(
      '/opt/homebrew/lib/node_modules/@goondocks/myco/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    );
  });

  it('returns undefined when no optional native package is present', () => {
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: 'file:///Users/chris/Repos/myco/packages/myco/src/agent/runtime/claude-code-executable.ts',
      execPath: '/opt/homebrew/lib/node_modules/@goondocks/myco/vendor/darwin-arm64/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: () => false,
      requireFactory: () => ({
        resolve() {
          throw new Error('missing');
        },
      }) as NodeJS.Require,
    });

    expect(executable).toBeUndefined();
  });
});
