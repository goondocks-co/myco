import { V86_EMBEDDING_SOURCES, embeddingSourcesView } from './embedding-sources.js';

/** Retire generated skills and digest extracts from the Deployment schema. */
export const V86_STATEMENTS: readonly string[] = [
  `DROP VIEW IF EXISTS embedding_sources`,
  `DROP TRIGGER IF EXISTS skill_records_fts_ai`,
  `DROP TRIGGER IF EXISTS skill_records_fts_au`,
  `DROP TRIGGER IF EXISTS skill_records_fts_ad`,
  `DROP TRIGGER IF EXISTS skill_records_embedding_ai`,
  `DROP TRIGGER IF EXISTS skill_records_embedding_au`,
  `DROP TRIGGER IF EXISTS skill_records_embedding_ad`,
  `DROP TABLE IF EXISTS skill_records_fts`,
  `DROP TABLE IF EXISTS skill_usage`,
  `DROP TABLE IF EXISTS skill_lineage`,
  `DROP TABLE IF EXISTS skill_records`,
  `DROP TABLE IF EXISTS skill_candidates`,
  `DROP TABLE IF EXISTS digest_extract_revisions`,
  `DROP TABLE IF EXISTS digest_extracts`,
  embeddingSourcesView(V86_EMBEDDING_SOURCES),
];
