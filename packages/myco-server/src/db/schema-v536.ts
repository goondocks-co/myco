import { reaching, type Reach, changing } from './schema-step.js';
const active = (row: 'OLD' | 'NEW'): string => `(${row}.failure IS NULL)`;

/** Queued waits retain their cause; status counts only active rows. */
export const V536_STATEMENTS: readonly string[] = [
  'ALTER TABLE publish_queue ADD COLUMN retry_cause TEXT CHECK (retry_cause IS NULL OR json_valid(retry_cause))',
  `CREATE INDEX IF NOT EXISTS idx_publish_queue_read_retries ON publish_queue (project_id,session_id,rank,created_at,event_id)
    WHERE failure IS NULL AND json_extract(retry_cause,'$.kind')='read' AND json_extract(retry_cause,'$.parentId') IS NULL`,
  ...(['INSERT', 'DELETE', 'UPDATE'] as const).flatMap(operation => {
    const delta = operation === 'INSERT' ? active('NEW') : operation === 'DELETE' ? `-${active('OLD')}` : `${active('NEW')}-${active('OLD')}`;
    const name = `publish_queue_facts_${operation.toLowerCase()}`;
    return [
      ...(operation === 'UPDATE' ? [] : [`DROP TRIGGER IF EXISTS ${name}`]),
      `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation === 'UPDATE' ? 'UPDATE OF failure' : operation} ON publish_queue
        WHEN (${delta})<>0 BEGIN UPDATE document_status_totals SET queued=queued+(${delta}) WHERE slot=1; END`,
    ];
  }),
];

/** Why the step reaches tables earlier steps created. */
export const V536_REACHES: readonly Reach[] = changing(['publish_queue'], 'Publication waits retain read and parent dependency causes independently of their retry deadline. Independent prompt read retries retain their order through a partial queue index. Active queue contributions replace the existing insertion and removal status counters in the same migration. Status totals of the queue count active events across insertion, removal and terminal-state transitions.');
