import type { LeafField } from './catalogue';
import type { LeafRow } from './wire';

/** Whether the server reports that a leaf has no consumer. */
export function isRetired(_field: LeafField, row: Pick<LeafRow, 'retired'> | undefined): boolean {
  return row?.retired === true;
}
