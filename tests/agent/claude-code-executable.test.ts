import { describe, expect, it } from 'bun:test';
import { resolveClaudeCodeExecutable } from '@myco/agent/runtime/claude-code-executable.js';

function expectedOptionalPackage(): string {
  if (process.platform === 'darwin') {
    return `@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`;
  }
  if (process.platform === 'win32') {
    return `@anthropic-ai/claude-agent-sdk-win32-${process.arch}`;
  }
  if (process.platform === 'linux') {
    return `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`;
  }
  throw new Error(`Unsupported test platform: ${process.platform}`);
}

function expectedExecutableName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

describe('resolveClaudeCodeExecutable', () => {
  it('resolves the optional CLI package from the installed package root on disk', () => {
    const optionalPackage = expectedOptionalPackage();
    const executableName = expectedExecutableName();
    const packageJsonPath = `/tmp/node_modules/${optionalPackage}/package.json`;
    const executablePath = `/tmp/node_modules/${optionalPackage}/${executableName}`;
    const calls: string[] = [];
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: 'file:///Users/chris/Repos/myco/packages/myco/src/agent/runtime/claude-code-executable.ts',
      execPath: '/tmp/vendor/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: (value) => value === executablePath,
      requireFactory: (_from) => ({
        resolve(specifier: string) {
          calls.push(specifier);
          if (specifier === `${optionalPackage}/package.json`) {
            return packageJsonPath;
          }
          throw new Error(`Cannot resolve ${specifier}`);
        },
      }) as NodeJS.Require,
    });

    expect(calls).toContain(`${optionalPackage}/package.json`);
    expect(executable).toBe(executablePath);
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
