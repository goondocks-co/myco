import { changing, type SchemaStep } from './schema-step.js';
import { NEXT_PUBLICATION_REOPEN } from './schema-vNEXT-publication-reopen.js';
import { publicationReopenSchemaStatements } from './documents/reopen.js';

export const PUBLICATION_REOPEN_STEPS: readonly SchemaStep[] = [{
  version: NEXT_PUBLICATION_REOPEN,
  statements: publicationReopenSchemaStatements(),
  reaches: [
    ...changing(['transcript_publication'], 'Each stopped publication records the admission revision that last reopened it.'),
    ...changing(['projection_catchup'], 'Stopped publications get one bounded retry for this admission revision.'),
  ],
}];
