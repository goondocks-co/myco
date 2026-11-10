import type { CatchupFamily } from '../projections/family.js';
import { SEARCH_BLOB_REFERENCE_PHASE } from './blob-index-schema.js';
import { SEARCH_DOCUMENTS_PROJECTION, SEARCH_DOCUMENT_PHASES } from './documents-schema.js';

/** The search projection's catch-up: each source kind's documents, then the proved blob references the indexer reads. */
export const SEARCH_DOCUMENTS_CATCHUP = {
  projection: SEARCH_DOCUMENTS_PROJECTION,
  phases: { ...SEARCH_DOCUMENT_PHASES, ...SEARCH_BLOB_REFERENCE_PHASE },
} as const satisfies CatchupFamily;
