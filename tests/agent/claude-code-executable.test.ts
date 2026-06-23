import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveClaudeCodeExecutable } from '@myco/agent/harness/claude-code-executable.js';

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

function runtimeModuleUrl(): string {
  return pathToFileURL(
    path.join(process.cwd(), 'packages/myco/src/agent/harness/claude-code-executable.ts'),
  ).href;
}

describe('resolveClaudeCodeExecutable', () => {
  it('resolves the optional CLI package from the installed package root on disk', () => {
    const optionalPackage = expectedOptionalPackage();
    const executableName = expectedExecutableName();
    const packageJsonPath = `/tmp/node_modules/${optionalPackage}/package.json`;
    const executablePath = `/tmp/node_modules/${optionalPackage}/${executableName}`;
    const calls: string[] = [];
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: runtimeModuleUrl(),
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

  it('falls back to a system-installed claude in ~/.local/bin for the standalone native binary', () => {
    // The standalone binary lives at ~/.myco/bin/myco with no node_modules
    // ancestor, so the bundled-package walk fails. The CLI the operator already
    // runs (~/.local/bin/claude) is the source. ~/.local/bin is checked
    // EXPLICITLY because the daemon's launchd PATH omits it.
    const home = '/Users/test';
    const systemClaude = path.join(home, '.local', 'bin', expectedExecutableName());
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: runtimeModuleUrl(),
      execPath: '/Users/test/.myco/bin/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: (value) => value === systemClaude,
      requireFactory: () => ({
        resolve() {
          throw new Error('no node_modules tree beside the standalone binary');
        },
      }) as NodeJS.Require,
      homeDir: home,
      env: { PATH: '' },
    });

    expect(executable).toBe(systemClaude);
  });

  it('finds a system claude on PATH when not in a known install dir', () => {
    const home = '/Users/test';
    const pathClaude = path.join('/custom/bin', expectedExecutableName());
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: runtimeModuleUrl(),
      execPath: '/Users/test/.myco/bin/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: (value) => value === pathClaude,
      requireFactory: () => ({
        resolve() {
          throw new Error('missing');
        },
      }) as NodeJS.Require,
      homeDir: home,
      env: { PATH: `/usr/sbin${path.delimiter}/custom/bin` },
    });

    expect(executable).toBe(pathClaude);
  });

  it('returns undefined when neither a bundled package nor a system claude is present', () => {
    const executable = resolveClaudeCodeExecutable({
      importMetaUrl: runtimeModuleUrl(),
      execPath: '/opt/homebrew/lib/node_modules/@goondocks/myco/vendor/darwin-arm64/myco',
      realpathSync: (value) => value as ReturnType<typeof Bun.file>,
      existsSync: () => false,
      requireFactory: () => ({
        resolve() {
          throw new Error('missing');
        },
      }) as NodeJS.Require,
      homeDir: '/Users/test',
      env: { PATH: '' },
    });

    expect(executable).toBeUndefined();
  });
});
