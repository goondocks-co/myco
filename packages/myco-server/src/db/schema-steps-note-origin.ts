import { NEXT_NOTE_ORIGIN } from './schema-vNEXT-note-origin.js';
import { changing, reaching, type SchemaStep } from './schema-step.js';
import { sporeOriginSchemaStatements } from './spores/origins.js';
import { SPORE_WRITTEN_AT_SEED } from './spores/written-at.js';

/**
 * Origin facts and their counts for a list narrowed by how its spores came to be, and the catch-up that dates spores an
 * earlier release's curation answers wrote by when they were written, a page of operation outputs at a time.
 */
export const NOTE_ORIGIN_STEPS: readonly SchemaStep[] = [{
  version: NEXT_NOTE_ORIGIN,
  statements: [...sporeOriginSchemaStatements(), SPORE_WRITTEN_AT_SEED],
  reaches: [
    ...reaching(['resolution_events', 'spore_curation_unit_members'], 'A consolidation and the operation that wrote a spore set how many spores it was written from.'),
    ...reaching(['spores'], 'A spore\'s own writes re-derive its origin fact.'),
    ...changing(['projection_catchup'], 'Origin facts and curated spores\' write times record whether existing rows need the catch-up.'),
  ],
}];
