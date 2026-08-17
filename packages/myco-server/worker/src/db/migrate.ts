import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { SCHEMA_DDL } from './schema.js';

/** Renders the schema as a single executable SQL script for deploy-time application. */
export function renderSchemaSql(): string {
  const statements = [
    ...SCHEMA_DDL,
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${SERVER_SCHEMA_VERSION}')`,
  ];
  return `${statements.map((s) => `${s};`).join('\n\n')}\n`;
}
