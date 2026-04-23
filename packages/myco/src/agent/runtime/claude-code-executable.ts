import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '@myco/utils/find-package-root.js';

interface ResolveClaudeExecutableDeps {
  importMetaUrl?: string;
  execPath?: string;
  realpathSync?: typeof fs.realpathSync;
  existsSync?: typeof fs.existsSync;
  requireFactory?: typeof createRequire;
}

function claudeExecutableName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function candidateOptionalPackages(): string[] {
  if (process.platform === 'darwin') {
    return [`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`];
  }

  if (process.platform === 'win32') {
    return [`@anthropic-ai/claude-agent-sdk-win32-${process.arch}`];
  }

  if (process.platform === 'linux') {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
    ];
  }

  return [];
}

function candidatePackageRoots(
  importMetaUrl: string,
  execPath: string,
  realpathSync: typeof fs.realpathSync,
): string[] {
  const candidates: string[] = [];

  try {
    candidates.push(path.dirname(fileURLToPath(importMetaUrl)));
  } catch {
    // Compiled Bun entrypoints can surface /$bunfs/ URLs; fall through to execPath.
  }

  try {
    candidates.push(path.dirname(realpathSync(execPath)));
  } catch {
    // Ignore realpath failures and return whatever import.meta already gave us.
  }

  return [...new Set(candidates)];
}

/**
 * Resolve the on-disk Claude Code executable shipped by the SDK's optional
 * native package for the current platform.
 *
 * Why this exists:
 * - In dev mode, the SDK's own lookup usually works.
 * - In the Bun-compiled binary, the SDK resolves relative to its bundled
 *   `import.meta.url`, which lives under `/$bunfs/...` and cannot see the real
 *   node_modules tree beside the installed package.
 *
 * We restore the SDK's intended package-relative lookup by resolving from the
 * installed Myco package root on disk, not by hardcoding an absolute binary
 * path per machine.
 */
let cachedResolution: { value: string | undefined } | undefined;

export function resolveClaudeCodeExecutable(
  deps: ResolveClaudeExecutableDeps = {},
): string | undefined {
  const hasInjectedDeps =
    deps.importMetaUrl !== undefined ||
    deps.execPath !== undefined ||
    deps.realpathSync !== undefined ||
    deps.existsSync !== undefined ||
    deps.requireFactory !== undefined;
  if (!hasInjectedDeps && cachedResolution) return cachedResolution.value;

  const importMetaUrl = deps.importMetaUrl ?? import.meta.url;
  const execPath = deps.execPath ?? process.execPath;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const requireFactory = deps.requireFactory ?? createRequire;

  for (const origin of candidatePackageRoots(importMetaUrl, execPath, realpathSync)) {
    const packageRoot = findPackageRoot(origin);
    if (!packageRoot) continue;

    const requireFromPackage = requireFactory(path.join(packageRoot, 'package.json'));
    for (const optionalPackage of candidateOptionalPackages()) {
      try {
        const packageJsonPath = requireFromPackage.resolve(`${optionalPackage}/package.json`);
        const executablePath = path.join(path.dirname(packageJsonPath), claudeExecutableName());
        if (existsSync(executablePath)) {
          if (!hasInjectedDeps) cachedResolution = { value: executablePath };
          return executablePath;
        }
      } catch {
        // Try the next platform candidate or package-root origin.
      }
    }
  }

  if (!hasInjectedDeps) cachedResolution = { value: undefined };
  return undefined;
}
