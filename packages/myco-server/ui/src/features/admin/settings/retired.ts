import type { LeafField } from './catalogue';
import { LEAF_DEFAULTS } from './defaults';
import type { LeafRow } from './wire';

/**
 * Whether the page treats a setting as retired: the server says nothing reads
 * its leaf any more. A setting whose value Myco keeps and shows (read-only,
 * with Myco's own value) is shown whatever the leaf, since the page reads that
 * value from the shared constant, not from the leaf.
 */
export function isRetired(field: LeafField, row: LeafRow | undefined): boolean {
  const entry = LEAF_DEFAULTS[field.leaf];
  const keptByMyco = field.readOnly === true && entry !== undefined && 'value' in entry;
  return row?.retired === true && !keptByMyco;
}
