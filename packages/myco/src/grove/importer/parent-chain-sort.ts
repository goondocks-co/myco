/**
 * Topological sort for tables with a self-referential parent column
 * (prompt_batches.parent_prompt_batch_id, digest_extract_revisions.
 * parent_revision_id). Parents are emitted before children so an insert
 * pass can resolve each row's remapped parent id from rows already
 * written. Shared by the Grove importer and the move rekey copy.
 */

export function sortRowsByParentChain<T>(
  rows: readonly T[],
  table: string,
  idOf: (row: T) => number,
  parentIdOf: (row: T) => number | null,
): T[] {
  const byId = new Map(rows.map((row) => [idOf(row), row]));
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const ordered: T[] = [];

  function visit(row: T): void {
    const id = idOf(row);
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Cycle in ${table} parent chain at ${id}`);
    }

    visiting.add(id);
    const parentId = parentIdOf(row);
    if (parentId != null) {
      const parent = byId.get(parentId);
      if (!parent) {
        throw new Error(`Missing source ${table} parent ${parentId} for ${id}`);
      }
      visit(parent);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(row);
  }

  for (const row of rows) visit(row);
  return ordered;
}
