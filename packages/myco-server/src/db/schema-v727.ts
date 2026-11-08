export const V727 = 727;

/**
 * Registered storage counters and ordered release queues. `storage_usage` holds registered logical bytes and blob count
 * per Project and for the Deployment (`project_id=''`), moved by triggers on `blobs` for every key the keyset build has
 * reached and by the build's own pages for the rest. `object_releases` is keyed by its effective due time: `retry_at` when
 * a delete is rescheduled, and `created_at` while `retry_at` is 0, so a row keeps the value it has and the index build is the only
 * work on existing rows. Each release candidate queue orders by arrival, and a blob candidate names the generation its
 * reference removal observed: `'*'` marks a candidate recorded before generations were observed. Frozen copy of
 * `storageUsageSchemaStatements` in db/storage/usage.ts, then the queue statements.
 */
export const V727_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS storage_usage(project_id TEXT PRIMARY KEY CHECK (project_id='' OR (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..'))),\n      blobs INTEGER NOT NULL DEFAULT 0,registered_logical_bytes INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID",
  "CREATE TRIGGER IF NOT EXISTS storage_usage_blob_insert AFTER INSERT ON blobs WHEN EXISTS(SELECT 1 FROM projection_catchup c WHERE c.projection='storage_usage' AND c.phase='blobUsage'\n  AND (c.done=1 OR (c.frontier IS NOT NULL AND ((NEW.project_id,NEW.key)<=(COALESCE(json_extract(c.after_key,'$[0]'),''),COALESCE(json_extract(c.after_key,'$[1]'),'')) OR (NEW.project_id,NEW.key)>(COALESCE(json_extract(c.frontier,'$[0]'),''),COALESCE(json_extract(c.frontier,'$[1]'),''))))))\n      BEGIN INSERT INTO storage_usage(project_id,blobs,registered_logical_bytes) VALUES(NEW.project_id,1,NEW.size),('',1,NEW.size)\n        ON CONFLICT(project_id) DO UPDATE SET blobs=blobs+1,registered_logical_bytes=registered_logical_bytes+excluded.registered_logical_bytes; END",
  "CREATE TRIGGER IF NOT EXISTS storage_usage_blob_delete AFTER DELETE ON blobs WHEN EXISTS(SELECT 1 FROM projection_catchup c WHERE c.projection='storage_usage' AND c.phase='blobUsage'\n  AND (c.done=1 OR (c.frontier IS NOT NULL AND ((OLD.project_id,OLD.key)<=(COALESCE(json_extract(c.after_key,'$[0]'),''),COALESCE(json_extract(c.after_key,'$[1]'),'')) OR (OLD.project_id,OLD.key)>(COALESCE(json_extract(c.frontier,'$[0]'),''),COALESCE(json_extract(c.frontier,'$[1]'),''))))))\n      BEGIN UPDATE storage_usage SET blobs=blobs-1,registered_logical_bytes=registered_logical_bytes-OLD.size WHERE project_id IN (OLD.project_id,''); END",
  "CREATE TRIGGER IF NOT EXISTS storage_usage_blob_size AFTER UPDATE OF size ON blobs WHEN OLD.size IS NOT NEW.size AND EXISTS(SELECT 1 FROM projection_catchup c WHERE c.projection='storage_usage' AND c.phase='blobUsage'\n  AND (c.done=1 OR (c.frontier IS NOT NULL AND ((NEW.project_id,NEW.key)<=(COALESCE(json_extract(c.after_key,'$[0]'),''),COALESCE(json_extract(c.after_key,'$[1]'),'')) OR (NEW.project_id,NEW.key)>(COALESCE(json_extract(c.frontier,'$[0]'),''),COALESCE(json_extract(c.frontier,'$[1]'),''))))))\n      BEGIN UPDATE storage_usage SET registered_logical_bytes=registered_logical_bytes-OLD.size+NEW.size WHERE project_id IN (NEW.project_id,''); END",
  "INSERT INTO projection_catchup(projection,phase,done) SELECT 'storage_usage','blobUsage',NOT EXISTS(SELECT 1 FROM blobs) ON CONFLICT DO NOTHING",
  "ALTER TABLE object_releases ADD COLUMN last_failure TEXT",
  "ALTER TABLE blob_release_candidates ADD COLUMN generation TEXT DEFAULT '*'",
  "DROP INDEX IF EXISTS idx_object_releases_retry",
  "DROP INDEX IF EXISTS idx_object_releases_created",
  "CREATE INDEX IF NOT EXISTS idx_object_releases_due ON object_releases((CASE WHEN retry_at=0 THEN created_at ELSE retry_at END),physical)",
  "CREATE INDEX IF NOT EXISTS idx_blob_release_candidates_due ON blob_release_candidates(created_at,project_id,key)",
  "CREATE INDEX IF NOT EXISTS idx_backup_release_candidates_due ON backup_release_candidates(created_at,id)",
];
