import { NEXT_REWIND } from './schema-vNEXT-rewind.js';
import { reaching, type SchemaStep } from './schema-step.js';

/** The retained release queue seeks objects whose rewind hold and delete retry have both ended. */
export const REWIND_STEPS: readonly SchemaStep[] = [{
  version: NEXT_REWIND,
  statements: ['CREATE INDEX IF NOT EXISTS idx_object_releases_retained_due ON object_releases((MAX(created_at+2592000000,retry_at)),physical)'],
  reaches: reaching(['object_releases'], 'The hosted drain seeks only stored objects past their 30-day rewind hold and retry deadline.'),
  deploymentIndexes: [{ index: 'idx_object_releases_retained_due', read: 'The hosted object drain seeks the next released object whose rewind hold and retry deadline have ended.' }],
}];
