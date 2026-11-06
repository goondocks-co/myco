import { admittedSourcePaths } from '@goondocks/myco-shared/canopy';
import type { SporeRow } from './spores.js';
import type { RepositoryInventory } from './repository-inventory.js';

export type SporeCurrency = { available: false; reason: 'no_code_map' | 'no_repository_inventory' | 'unresolved_anchors' | 'snapshot_behind' | 'snapshot_moved'; unresolved?: string[] }
  | { available: true; commit: string; present: string[]; missing: string[]; unresolved: string[] };
export type CurrencySnapshot = {available:true;commit:string;generatedAt:number}
  | {available:false;reason:'no_code_map'|'no_repository_inventory'};
interface InventoryIndex { suffixes: ReadonlySet<string>; roots: ReadonlySet<string>; extensions: ReadonlySet<string> }
const indexes = new WeakMap<RepositoryInventory, InventoryIndex>();
const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();

function indexOf(inventory: RepositoryInventory): InventoryIndex {
  let index = indexes.get(inventory);
  if (index !== undefined) return index;
  const suffixes = new Set<string>();
  for (const path of admittedSourcePaths(inventory.files.map(path => ({path})))) {
    const parts = path.split('/');
    for (let i=0;i<parts.length;i++) suffixes.add(parts.slice(i).join('/'));
  }
  index = {suffixes,roots:new Set(inventory.files.map(path=>path.split('/')[0]!)),extensions:new Set(inventory.files.flatMap(path=>extension(path) ?? []))};
  indexes.set(inventory,index);
  return index;
}

/** Repository file tokens use extensions held by the snapshot; symbols, refs and provider names are not anchors. */
export function sporeCodeAnchors(spore: Pick<SporeRow, 'filePath' | 'content'>, inventory: RepositoryInventory): string[] {
  const body = spore.content.replace(/https?:\/\/[^\s<>`]+/g, '');
  const tokens = [...body.matchAll(/(?<![\w/@.-])(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-z][\w.-]*(?::\d+(?::\d+)?)?/gi)].map(match=>match[0]);
  tokens.push(...[...body.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\/?)`/g)].map(match=>match[1]!));
  const { extensions,suffixes } = indexOf(inventory);
  return [...new Set([spore.filePath,...tokens].flatMap(value=>{
    if (value === null) return [];
    const path = value.replace(/^\.\//,'').replace(/[.,;]+$/,'').replace(/\/$/,'').replace(/(?::\d+(?::\d+)?|#.*)$/,'');
    const ext = extension(path);
    return !path || path.startsWith('/') || path.startsWith('@') || /^[a-z]:/i.test(path) || path.includes('://')
      || path.split('/').some(part=>!part || part==='.' || part==='..') || (ext===undefined ? !path.includes('/') || !suffixes.has(path) : !extensions.has(ext)) ? [] : [path];
  }))].sort();
}

/** Only snapshot-rooted absences are missing; newer knowledge and unresolved names carry no absence fact. */
export function sporeCurrency(spore: Pick<SporeRow, 'filePath' | 'content'> & Partial<Pick<SporeRow,'createdAt'|'updatedAt'>>, inventory: RepositoryInventory | null, hasMap: boolean): SporeCurrency {
  if (inventory === null) return {available:false,reason:hasMap?'no_repository_inventory':'no_code_map'};
  const anchors = sporeCodeAnchors(spore,inventory), {suffixes,roots} = indexOf(inventory);
  const present = anchors.filter(path=>suffixes.has(path));
  const absent = anchors.filter(path=>!suffixes.has(path));
  const missing = absent.filter(path=>path.includes('/') && roots.has(path.split('/')[0]!));
  const unresolved = absent.filter(path=>!missing.includes(path));
  if (missing.length>0 && Math.max(spore.createdAt ?? 0,spore.updatedAt ?? 0)>inventory.generatedAt) return {available:false,reason:'snapshot_behind'};
  if (unresolved.length>0 && present.length===0 && missing.length===0) return {available:false,reason:'unresolved_anchors',unresolved};
  return {available:true,commit:inventory.commit,present,missing,unresolved};
}

export const allAnchorsMissing = (currency: SporeCurrency | null): boolean => currency !== null && currency.available && currency.present.length === 0 && currency.missing.length > 0;
