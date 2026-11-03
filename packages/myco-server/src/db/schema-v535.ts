/** Publication retains terminal event holds and schedules transient retries independently. */
export const V535_STATEMENTS: readonly string[] = [
  'ALTER TABLE publish_queue ADD COLUMN failure TEXT',
  'ALTER TABLE publish_queue ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_publish_queue_active ON publish_queue (project_id,session_id,rank,created_at,event_id) WHERE failure IS NULL',
];
