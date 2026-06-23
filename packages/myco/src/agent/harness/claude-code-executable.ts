import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findCorePackageRoot } from '@myco/utils/find-package-root.js';

interface ResolveClaudeExecutableDeps {
  importMetaUrl?: string;
  execPath?: string;
  realpathSync?: typeof fs.realpathSync;
  existsSync?: typeof fs.existsSync;
  requireFactory?: typeof createRequire;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
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

/**
 * Known on-disk locations of a user-installed Claude Code CLI, plus PATH dirs.
 * Checked EXPLICITLY (not only via PATH) because the daemon runs under
 * launchd's minimal PATH, which omits ~/.local/bin — the native installer's
 * default CLI location — so a PATH-only lookup would miss it.
 */
function systemClaudeCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const name = claudeExecutableName();
  const candidates = [
    path.join(homeDir, '.local', 'bin', name),
    path.join('/opt', 'homebrew', 'bin', name),
    path.join('/usr', 'local', 'bin', name),
  ];
  // PATH dirs cover non-standard installs, but only ABSOLUTE ones: the resolved
  // binary is spawned with bypassPermissions, so a relative/`.` PATH entry must
  // never decide what runs (cwd-relative hijack). The trusted dirs above are
  // checked first and win via the dedupe.
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim() && path.isAbsolute(dir)) candidates.push(path.join(dir, name));
  }
  return [...new Set(candidates)];
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
    deps.requireFactory !== undefined ||
    deps.homeDir !== undefined ||
    deps.env !== undefined;
  if (!hasInjectedDeps && cachedResolution) return cachedResolution.value;

  const importMetaUrl = deps.importMetaUrl ?? import.meta.url;
  const execPath = deps.execPath ?? process.execPath;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const requireFactory = deps.requireFactory ?? createRequire;
  const homeDir = deps.homeDir ?? os.homedir();
  const env = deps.env ?? process.env;

  for (const origin of candidatePackageRoots(importMetaUrl, execPath, realpathSync)) {
    // Resolve from @goondocks/myco core so requireFromPackage below
    // can find the SDK's platform-specific optional packages sitting
    // alongside it in node_modules.
    const packageRoot = findCorePackageRoot(origin);
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

  // Fall back to a user-installed Claude Code CLI. The standalone native
  // binary has no node_modules tree beside it, so the SDK's bundled optional
  // package is unreachable; a system install (the one the operator already
  // runs) is the expected source. Myco does not ship its own copy.
  for (const candidate of systemClaudeCandidates(homeDir, env)) {
    if (existsSync(candidate)) {
      if (!hasInjectedDeps) cachedResolution = { value: candidate };
      return candidate;
    }
  }

  if (!hasInjectedDeps) cachedResolution = { value: undefined };
  return undefined;
}
