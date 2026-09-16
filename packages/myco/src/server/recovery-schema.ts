/**
 * The operator side of the recovery schema owner: the shared facts come from server core, and this adds the
 * validation that parses a schema read back from a provider or a staging.
 */
import { z } from 'zod';

export {
  exportedTables, quoteIdentifier, recoverableVirtualTables, SCHEMA_QUERY,
  type RecoverySchemaObject,
} from '@myco-server-worker/core/recovery-schema.js';

const schemaObject = z.object({
  type: z.enum(['table', 'index', 'view', 'trigger']), name: z.string().min(1), sql: z.string().min(1),
  storage: z.enum(['table', 'virtual', 'view']).nullable(),
});
export const schemaObjects = z.array(schemaObject);
