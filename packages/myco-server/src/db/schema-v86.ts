import { retiring, type Retirement } from './schema-step.js';
import { V86_EMBEDDING_SOURCES, embeddingSourcesView } from './embedding-sources.js';

/** Retire generated skills, digests and project instructions from the Deployment schema. */
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
  `DROP TABLE IF EXISTS cortex_instructions`,
  `DELETE FROM knowledge_release_state WHERE namespace IN ('skill', 'skill_records', 'digest', 'digest_extracts')`,
  `DELETE FROM embedding_source_failures WHERE type IN ('skill', 'digest', 'digest_extracts')`,
  `DELETE FROM embedding_versions WHERE type IN ('skill', 'digest', 'digest_extracts')`,
  embeddingSourcesView(V86_EMBEDDING_SOURCES),
];

export const V86_RETIRES: readonly Retirement[] = [
  ...retiring('trigger', ['fts', 'embedding'].flatMap((kind) => ['ai', 'au', 'ad'].map((action) => `skill_records_${kind}_${action}`)),
    'Generated skills are retired: nothing writes skill records, so nothing indexes or embeds them.'),
  ...retiring('table', ['skill_records_fts', 'skill_usage', 'skill_lineage', 'skill_records', 'skill_candidates', 'digest_extract_revisions',
    'digest_extracts', 'cortex_instructions'], 'Generated skills, digests and project instructions are retired from the Deployment schema.'),
];
