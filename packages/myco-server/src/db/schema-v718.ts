import { reaching, type Reach, type DeploymentIndex, changing } from './schema-step.js';
export const V718 = 718;
export const V718_STATEMENTS: readonly string[] = [
  "ALTER TABLE session_documents ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE session_documents ADD COLUMN publication_after TEXT",
  "ALTER TABLE session_documents ADD COLUMN publication_pass_changed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE session_documents ADD COLUMN publication_scan_due INTEGER",
  "CREATE INDEX IF NOT EXISTS idx_publication_owner_pages ON session_pages(project_id,session_id,generation,owner,sealed,page)",
  "CREATE INDEX IF NOT EXISTS idx_publication_transcripts ON transcripts(project_id,session_id,CASE role WHEN 'subagent' THEN 1 ELSE 0 END,first_received_at,transcript_id)",
  "CREATE INDEX IF NOT EXISTS idx_publication_reopen ON transcript_publication(parser_version,project_id,transcript_id) WHERE state='failed'",
  "CREATE INDEX IF NOT EXISTS idx_publish_ready ON publish_queue(project_id,session_id,rank,created_at,event_id) WHERE failure IS NULL AND retry_cause IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_publish_sleeping ON publish_queue(project_id,session_id,retry_at,rank,created_at,event_id) WHERE failure IS NULL AND retry_cause IS NOT NULL",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_transcripts_insert AFTER INSERT ON transcripts\n        BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL\n          WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id) AND publication_after IS NOT NULL;\n           END",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_transcripts_update AFTER UPDATE OF project_id,session_id,transcript_id,size,role,first_received_at,last_received_at,prompt_identity_scheme,record_identity_scheme ON transcripts\n        BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL\n          WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id) AND publication_after IS NOT NULL;\n          UPDATE session_documents SET publication_input_revision=publication_input_revision+1\n            WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id) AND OLD.first_received_at IS NOT NEW.first_received_at; END",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_transcripts_delete AFTER DELETE ON transcripts\n        BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL\n          WHERE (project_id,session_id)=(OLD.project_id,OLD.session_id) AND publication_after IS NOT NULL;\n           END",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_frontier_rewind AFTER UPDATE OF published_offset,state,parser_version ON transcript_publication\n      WHEN NEW.published_offset<OLD.published_offset OR (OLD.state='failed' AND NEW.state<>'failed') OR NEW.parser_version<OLD.parser_version\n      BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL\n        WHERE (project_id,session_id,generation)=(NEW.project_id,NEW.session_id,NEW.generation) AND publication_after IS NOT NULL; END",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_lifecycle AFTER UPDATE OF ended_at,working_since,last_turn_end_at ON sessions\n      WHEN OLD.ended_at IS NOT NEW.ended_at OR OLD.working_since IS NOT NEW.working_since OR OLD.last_turn_end_at IS NOT NEW.last_turn_end_at\n      BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL,publication_input_revision=publication_input_revision+1\n        WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id); END",
  "CREATE TRIGGER IF NOT EXISTS publication_directory_generation AFTER UPDATE OF generation ON session_documents\n      WHEN OLD.generation IS NOT NEW.generation BEGIN UPDATE session_documents SET publication_after=NULL,publication_scan_due=NULL,\n        published_revision=published_revision+1 WHERE (project_id,session_id)=(NEW.project_id,NEW.session_id); END"
];

/** Why the step reaches tables earlier steps created. */
export const V718_REACHES: readonly Reach[] = [
  ...changing(['session_documents'], 'Publication records its directory cursor and committed revision without backfilling history. Publication seeks bounded directories and due arms; keyed input changes restart their cursors.'),
  ...reaching(['session_pages', 'transcripts', 'transcript_publication', 'publish_queue', 'sessions'], 'Publication seeks bounded directories and due arms; keyed input changes restart their cursors.'),
];

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V718_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_publication_reopen', read: 'stopped publication candidates are ordered by parser version across the Deployment' },
];
