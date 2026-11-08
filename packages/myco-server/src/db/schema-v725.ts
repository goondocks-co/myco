export const V725 = 725;

/**
 * Calibration member vectors move to immutable stored pages. Members gain the page and frame holding their vector, the
 * page table records each object and how many members name it, and a partial index finds the settled members still
 * holding their bytes. Exact moments stay on the member rows. Frozen copies of `vectorPageSchema` and
 * `vectorPageTriggers` in db/embeddings/vector-pages.ts.
 */
export const V725_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS embedding_vector_pages(page_id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),model_key TEXT NOT NULL,\n      object_key TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,state INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0,1)),\n      live INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,missing_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_embedding_vector_pages_unreferenced ON embedding_vector_pages(project_id,page_id) WHERE live=0",
  "ALTER TABLE embedding_hubness_members ADD COLUMN page_id INTEGER",
  "ALTER TABLE embedding_hubness_members ADD COLUMN page_offset INTEGER",
  "ALTER TABLE embedding_hubness_members ADD COLUMN page_length INTEGER",
  "CREATE INDEX IF NOT EXISTS idx_embedding_hubness_members_inline ON embedding_hubness_members(project_id,model_key,id) WHERE state=0 AND page_id IS NULL",
  "CREATE TRIGGER IF NOT EXISTS embedding_vector_page_member_update AFTER UPDATE OF page_id ON embedding_hubness_members WHEN OLD.page_id IS NOT NEW.page_id BEGIN\n        UPDATE embedding_vector_pages SET live=live-1 WHERE page_id=OLD.page_id; UPDATE embedding_vector_pages SET live=live+1 WHERE page_id=NEW.page_id; END",
  "CREATE TRIGGER IF NOT EXISTS embedding_vector_page_member_delete AFTER DELETE ON embedding_hubness_members WHEN OLD.page_id IS NOT NULL BEGIN\n        UPDATE embedding_vector_pages SET live=live-1 WHERE page_id=OLD.page_id; END",
];
