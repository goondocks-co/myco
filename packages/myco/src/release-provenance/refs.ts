import { runGit } from './git-cmd.js';

const GLOB_CHARS = /[*?[]/;

export function resolveConfiguredRefs(projectRoot: string, refs: readonly string[]): string[] {
  const allRefsCache: { value?: string[] } = {};
  const resolved: string[] = [];

  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    if (!GLOB_CHARS.test(trimmed)) {
      resolved.push(trimmed);
      continue;
    }

    const allRefs = allRefsCache.value ?? listAllRefs(projectRoot);
    allRefsCache.value = allRefs;
    const matcher = globToRegex(trimmed);
    for (const candidate of allRefs) {
      if (refAliases(candidate).some((alias) => matcher.test(alias))) {
        resolved.push(candidate);
      }
    }
  }

  return [...new Set(resolved)];
}

export function refAliases(ref: string): string[] {
  const aliases = [ref];
  for (const prefix of ['refs/tags/', 'refs/heads/', 'refs/remotes/']) {
    if (ref.startsWith(prefix)) aliases.push(ref.slice(prefix.length));
  }
  return aliases;
}

function listAllRefs(projectRoot: string): string[] {
  const result = runGit(projectRoot, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
