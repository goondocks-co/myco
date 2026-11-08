/** Publication directory state and the indexes used by its bounded reads. */
export function publicationDirectorySchema(): string[] {
  return [
    'ALTER TABLE session_documents ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE session_documents ADD COLUMN publication_after TEXT',
    'ALTER TABLE session_documents ADD COLUMN publication_pass_changed INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE session_documents ADD COLUMN publication_scan_due INTEGER',
    'CREATE INDEX IF NOT EXISTS idx_publication_owner_pages ON session_pages(project_id,session_id,generation,owner,sealed,page)',
    "CREATE INDEX IF NOT EXISTS idx_publication_transcripts ON transcripts(project_id,session_id,CASE role WHEN 'subagent' THEN 1 ELSE 0 END,first_received_at,transcript_id)",
    "CREATE INDEX IF NOT EXISTS idx_publication_reopen ON transcript_publication(parser_version,project_id,transcript_id) WHERE state='failed'",
    'CREATE INDEX IF NOT EXISTS idx_publish_ready ON publish_queue(project_id,session_id,rank,created_at,event_id) WHERE failure IS NULL AND retry_cause IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_publish_sleeping ON publish_queue(project_id,session_id,retry_at,rank,created_at,event_id) WHERE failure IS NULL AND retry_cause IS NOT NULL',
    ...['insert', 'update', 'delete'].map(action => {
      const row = action === 'delete' ? 'OLD' : 'NEW';
      return `CREATE TRIGGER IF NOT EXISTS publication_directory_transcripts_${action} AFTER ${action === 'update'
        ? 'UPDATE OF project_id,session_id,transcript_id,size,role,first_received_at,last_received_at,prompt_identity_scheme,record_identity_scheme' : action.toUpperCase()} ON transcripts
        BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL
          WHERE (project_id,session_id)=(${row}.project_id,${row}.session_id) AND publication_after IS NOT NULL;
          ${action === 'update' ? `UPDATE session_documents SET publication_input_revision=publication_input_revision+1
            WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id) AND OLD.first_received_at IS NOT NEW.first_received_at;` : ''} END`;
    }),
    `CREATE TRIGGER IF NOT EXISTS publication_directory_frontier_rewind AFTER UPDATE OF published_offset,state,parser_version ON transcript_publication
      WHEN NEW.published_offset<OLD.published_offset OR (OLD.state='failed' AND NEW.state<>'failed') OR NEW.parser_version<OLD.parser_version
      BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL
        WHERE (project_id,session_id,generation)=(NEW.project_id,NEW.session_id,NEW.generation) AND publication_after IS NOT NULL; END`,
    `CREATE TRIGGER IF NOT EXISTS publication_directory_lifecycle AFTER UPDATE OF ended_at,working_since,last_turn_end_at ON sessions
      WHEN OLD.ended_at IS NOT NEW.ended_at OR OLD.working_since IS NOT NEW.working_since OR OLD.last_turn_end_at IS NOT NEW.last_turn_end_at
      BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL,publication_input_revision=publication_input_revision+1
        WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id); END`,
    `CREATE TRIGGER IF NOT EXISTS publication_directory_generation AFTER UPDATE OF generation ON session_documents
      WHEN OLD.generation IS NOT NEW.generation BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL,
        published_revision=published_revision+1 WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id); END`,
  ];
}
