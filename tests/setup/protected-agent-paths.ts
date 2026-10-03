import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const manifests = fileURLToPath(new URL('../../packages/myco/src/symbionts/manifests/', import.meta.url));

/** Home paths declared by each manifest, including registration and credentials. */
function homePaths(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('~/') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(homePaths);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(homePaths);
  return [];
}

/** Shared config containers are protected at the declared application subtree. */
function agentRoot(homePath: string): string {
  const parts = homePath.slice(2).split('/');
  if (parts[0] === '.config' || parts[0] === '.codeium') return parts.slice(0, 2).join('/');
  if (parts[0] === 'Library') return path.posix.dirname(homePath.slice(2));
  return parts[0]!;
}

export function protectedAgentPaths(home: string): string[] {
  const roots = fs.readdirSync(manifests).filter((name) => name.endsWith('.yaml'))
    .flatMap((name) => homePaths(parse(fs.readFileSync(path.join(manifests, name), 'utf8'))))
    .map(agentRoot);
  return [...new Set([...roots, '.agents'])].map((root) => path.join(home, root));
}
