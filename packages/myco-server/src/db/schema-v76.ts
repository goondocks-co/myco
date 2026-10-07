/** Session-ordered cleanup queue pages seek across identities without sorting a backlog. */
export const V76_STATEMENTS:readonly string[]=[
  `CREATE INDEX IF NOT EXISTS idx_storage_cleanup_queue_packing
    ON storage_cleanup_queue(project_id,session_id,resource_kind,resource_id)`,
];
