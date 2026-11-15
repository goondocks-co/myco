import { changing, type SchemaStep } from './schema-step.js';
import { NEXT_CONTEXT_DELIVERY } from './schema-vNEXT-context-delivery.js';
import { kpiTriggers } from './insights/kpi-reconcile.js';
import { contextPlacementSchemaStatements } from './sessions/placement-schema.js';
import { RECEIPT_EXCLUSION_TRIGGERS, SERVED_ITEMS_PROJECTION } from './context/served-items.js';

/** Preserve every receipt and reference while allowing undelivered text to be selected again. */
export function contextDeliverySteps(receiptBody: string, indexes: readonly string[]): readonly SchemaStep[] {
  const columns = 'project_id,session_id,id,prompt_id,scope_reason,ask_protocol,asked_at,delivered_at,delivered_prompt_id,delivered_scope_reason,prompt_hash,spore_ids,plan_ids,created_at';
  return [{
    version: NEXT_CONTEXT_DELIVERY,
    statements: [
      'CREATE TABLE _context_receipts AS SELECT rowid AS saved_rowid,* FROM spore_injections',
      'DROP TABLE spore_injections',
      `CREATE TABLE spore_injections ${receiptBody.replace('     UNIQUE (project_id, session_id, prompt_hash),', '').replace('prompt_hash TEXT NOT NULL,', 'discarded_at INTEGER, prompt_hash TEXT NOT NULL,')}`,
      `INSERT INTO spore_injections(rowid,${columns}) SELECT saved_rowid,${columns} FROM _context_receipts`,
      'DROP TABLE _context_receipts',
      ...indexes,
      'CREATE INDEX IF NOT EXISTS idx_spore_injections_hash ON spore_injections(project_id,session_id,prompt_hash)',
      ...kpiTriggers().filter(trigger => trigger.table === 'spore_injections').map(trigger => trigger.sql),
      ...contextPlacementSchemaStatements().filter(sql => /^CREATE TRIGGER[^]* ON spore_injections /.test(sql)),
      'ALTER TABLE session_served_items ADD COLUMN reservation_expires_at INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE session_served_items ADD COLUMN reservation_receipt_id TEXT',
      'CREATE INDEX IF NOT EXISTS idx_session_served_reservation ON session_served_items(project_id,session_id,reservation_receipt_id)',
      'CREATE INDEX IF NOT EXISTS idx_session_served_expiry ON session_served_items(project_id,reservation_expires_at) WHERE reservation_expires_at>0',
      'DELETE FROM session_served_items',
      ...RECEIPT_EXCLUSION_TRIGGERS.map(trigger => trigger.sql),
      `UPDATE projection_catchup SET done=NOT EXISTS(SELECT 1 FROM spore_injections),after_key='[]',frontier=NULL WHERE projection='${SERVED_ITEMS_PROJECTION}'`,
    ],
    retires: [{ kind: 'table', name: '_context_receipts', reason: 'Every receipt is copied back with its original identity and delivery state.' }, { kind: 'table', name: 'spore_injections', reason: 'The rebuilt receipt table admits another undelivered selection of the same text.' }],
    reaches: [
      ...changing(['spore_injections', 'session_served_items', 'projection_catchup'], 'Delivery exclusions and expiring reservations rebuild from immutable receipts.'),
    ],
    deploymentIndexes: [
      { index: 'idx_spore_injections_hash', read: 'Receipt admission seeks prior selections for the prompt text.' },
      { index: 'idx_session_served_expiry', read: 'Retention reads a bounded page of expired reservations in each Project.' },
      { index: 'idx_session_served_reservation', read: 'Discard releases only the memberships owned by its receipt.' },
    ],
  }];
}
