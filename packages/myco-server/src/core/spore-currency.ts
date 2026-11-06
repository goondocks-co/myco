import type { SporeRow } from './spores.js';
import type { readRepositoryInventory } from './repository-inventory.js';

export type SporeCurrency = { available: false; reason: 'no_code_map' | 'no_repository_inventory' }
  | { available: true; commit: string; present: string[]; missing: string[] };

/** Repository-relative file anchors; locations and fragments do not change file identity. */
function anchor(value: string): string | null {
  const path = value.replace(/^\.\//, '').replace(/[.,;]+$/, '').replace(/\/$/, '').replace(/(?::\d+(?::\d+)?|#.*)$/, '');
  return !path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('~/') || path.includes('://') || path.split('/').some(part => !part || part === '..' || part === '.') ? null : path;
}

/** Explicit file metadata and repository paths named by the body form one distinct anchor set. */
export function sporeCodeAnchors(spore: Pick<SporeRow, 'filePath' | 'content'>): string[] {
  const body = spore.content.replace(/https?:\/\/[^\s<>`]+/g, '');
  const paths = [...body.matchAll(/(?<![\w/.-])(?:\.\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z][\w.-]*(?::\d+(?::\d+)?)?/g)].map(match => match[0]);
  for (const match of body.matchAll(/`((?:[\w@.-]+\/)+[\w@.-]+\/?|[\w@.-]+\.[A-Za-z][\w.-]*)`/g)) paths.push(match[1]!);
  return [...new Set([spore.filePath, ...paths].flatMap(path => path === null ? [] : [anchor(path)].filter((path): path is string => path !== null)))].sort();
}

/** Existence is computed against the complete committed inventory, never against map annotation coverage. */
export function sporeCurrency(spore: Pick<SporeRow, 'filePath' | 'content'>, inventory: Awaited<ReturnType<typeof readRepositoryInventory>>, hasMap: boolean): SporeCurrency {
  if (inventory === null) return { available: false, reason: hasMap ? 'no_repository_inventory' : 'no_code_map' };
  const paths = sporeCodeAnchors(spore);
  const exists = (path: string) => inventory.paths.has(path);
  return { available: true, commit: inventory.commit, present: paths.filter(exists), missing: paths.filter(path => !exists(path)) };
}

export const allAnchorsMissing = (currency: SporeCurrency): boolean => currency.available && currency.present.length === 0 && currency.missing.length > 0;
