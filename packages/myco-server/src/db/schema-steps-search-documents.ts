import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_SEARCH } from './schema-vNEXT-search.js';
import { searchDocumentStatements } from './search/documents-schema.js';
import { searchBlobIndexStatements } from './search/blob-index-schema.js';
import { searchResultWindowStatements } from './search/result-windows-schema.js';

/**
 * One search index over sessions, plans, spores and conversation cards, built live: the tables and the triggers that
 * keep each record's document current, then a catch-up that adds the existing records page by page. No statement here
 * reads an existing table's rows beyond the catch-up seed's existence checks.
 */
export const VNEXT_SEARCH_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_SEARCH,
    statements: [...searchDocumentStatements(), ...searchBlobIndexStatements(), ...searchResultWindowStatements()],
    reaches: [
      ...reaching(['sessions', 'plans', 'spores', 'turn_cards', 'processed_resources'],
        'Each searchable record keeps its search document, and each proved plan body its blob reference, in the statement that writes the record.'),
      ...changing(['projection_catchup'], 'The search projection starts building, so search answers say it is building until every existing record is indexed.'),
    ],
    deploymentIndexes: [
      { index: 'idx_search_blobs_due', read: 'the search indexer takes the soonest due blob across the Deployment' },
      { index: 'idx_search_blobs_waiting', read: 'Health reads the longest-waiting blob across the Deployment' },
      { index: 'idx_search_result_windows_expiry', read: 'storing a search ranking removes rankings that have expired, soonest first, across the Deployment' },
      { index: 'idx_search_result_windows_reader', read: 'storing a search ranking evicts that reader\'s oldest beyond its cap' },
    ],
  },
];
