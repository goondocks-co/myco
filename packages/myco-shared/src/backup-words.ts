/** Retired backup tables and the names their data has for an owner. */
export const RETIRED_BACKUP_TABLES: ReadonlyMap<string, { version: number; name: string; namespaces?: readonly string[] }> = new Map([
  ['skill_candidates', { version: 86, name: 'generated skills' }],
  ['skill_records', { version: 86, name: 'generated skills', namespaces: ['skill'] }],
  ['skill_lineage', { version: 86, name: 'generated skills' }],
  ['skill_usage', { version: 86, name: 'generated skills' }],
  ['digest_extracts', { version: 86, name: 'digests', namespaces: ['digest'] }],
  ['digest_extract_revisions', { version: 86, name: 'digests' }],
  ['cortex_instructions', { version: 86, name: 'old instructions' }],
]);

/** The retired table named directly or by a release-state namespace. */
export function retiredBackupTable(source: unknown): string | undefined {
  if (typeof source !== 'string') return undefined;
  return [...RETIRED_BACKUP_TABLES].find(([table, kind]) => table === source || kind.namespaces?.includes(source))?.[0];
}

/** One notice for the retired data actually present in a backup. */
export function retiredBackupNotice(counts: Readonly<Record<string, number>>): string | null {
  const names = [...new Set([...RETIRED_BACKUP_TABLES]
    .filter(([table]) => (counts[table] ?? 0) > 0).map(([, kind]) => kind.name))];
  return names.length === 0 ? null
    : `This backup includes older data this version no longer keeps (${names.join(', ')}). It won't be restored.`;
}
