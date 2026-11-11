import { blobObjectKeySql } from '../../core/blob-objects.js';

/**
 * SQL for the stored object the registered row of blob `key` in Project `project` names, or NULL when no row registers
 * it. `project` and `key` are SQL expressions of the enclosing statement.
 */
export function registeredObjectKeySql(project: string, key: string): string {
  return `(SELECT ${blobObjectKeySql('ro.project_id', 'ro.key', 'ro.generation')} FROM blobs ro WHERE ro.project_id = ${project} AND ro.key = ${key})`;
}
