import { MACHINE_UPDATE_LEAVES } from '@goondocks/myco-shared/member-protocol';
import { reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_MACHINE_UPDATES } from './schema-vNEXT-machine-updates.js';

const OPERATIONS = ['insert', 'update', 'delete'] as const;
const triggerName = (operation: string) => `machine_settings_${operation}_revision`;
const UPDATE_LEAVES = MACHINE_UPDATE_LEAVES.map(leaf => `'${leaf}'`).join(',');
const REASON = 'Capture revisions track capture leaves; update requests carry their own application state.';

export const MACHINE_UPDATE_STEPS: readonly SchemaStep[] = [{
  version: NEXT_MACHINE_UPDATES,
  statements: OPERATIONS.flatMap(operation => {
    const row = operation === 'delete' ? 'OLD' : 'NEW';
    return [
      `DROP TRIGGER IF EXISTS ${triggerName(operation)}`,
      `CREATE TRIGGER IF NOT EXISTS ${triggerName(operation)} AFTER ${operation.toUpperCase()} ON machine_settings
        WHEN ${row}.leaf NOT IN (${UPDATE_LEAVES}) BEGIN
        UPDATE machine_claims SET settings_revision=settings_revision+1 WHERE machine_id=${row}.machine_id; END`,
    ];
  }),
  retires: retiring('trigger', OPERATIONS.map(triggerName), REASON),
  reaches: reaching(['machine_settings'], REASON),
}];
