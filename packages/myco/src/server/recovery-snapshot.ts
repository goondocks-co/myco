/**
 * The single owner of snapshot reconstruction: an ordinary-table SQL export plus the source's schema objects become a
 * standalone database. The Cloudflare backup and staging materialization both build their snapshot here.
 */
import { Database } from 'bun:sqlite';
import { identifierAt, importTableDump, runOneStatement, significantStatement } from './sql-dump.js';
import { exportedTables, quoteIdentifier, recoverableVirtualTables, SCHEMA_QUERY, schemaObjects } from './recovery-schema.js';

export { exportedTables };

export type RecoverySchemaObjects = ReturnType<typeof schemaObjects.parse>;
type RecoverySchemaObject = RecoverySchemaObjects[number];

/** Refuses a schema this recovery path cannot reconstruct, before a source is asked for its contents. */
export function assertRecoverableSchema(schema: RecoverySchemaObjects): void {
  recoverableVirtualTables(schema);
}

const EXISTS = '(?:IF\\s+NOT\\s+EXISTS\\s+)?';
const CREATE_FORM: Record<RecoverySchemaObject['type'], RegExp> = {
  index: new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${EXISTS}`, 'i'),
  view: new RegExp(`^CREATE\\s+VIEW\\s+${EXISTS}`, 'i'),
  trigger: new RegExp(`^CREATE\\s+TRIGGER\\s+${EXISTS}`, 'i'),
  table: new RegExp(`^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+${EXISTS}`, 'i'),
};

/** Holds one captured schema object to its declared kind, storage and name, then creates it as a single statement. */
function createSchemaObject(db: Database, row: RecoverySchemaObject): void {
  const sql = significantStatement(row.sql);
  const form = CREATE_FORM[row.type].exec(sql);
  if (form === null) throw new Error(`recovery schema object ${row.name} does not declare a ${row.type}`);
  if ((row.storage === 'virtual') !== /^CREATE\s+VIRTUAL\s/i.test(sql)) {
    throw new Error(`recovery schema object ${row.name} disagrees with its storage`);
  }
  const named = identifierAt(sql, form[0].length);
  if (named === null || named.qualified || named.name !== row.name) {
    throw new Error(`recovery schema object ${row.name} names ${named?.name ?? 'nothing'}`);
  }
  runOneStatement(db, row.sql);
}

/**
 * Builds the snapshot at `file` from `sqlPath`, then creates every non-table object `schema` declares and refuses a
 * result whose own schema differs from it. One transaction: a refusal leaves no partially reconstructed database.
 */
export async function buildSnapshotDatabase(file: string, sqlPath: string, schema: RecoverySchemaObjects): Promise<void> {
  const virtual = recoverableVirtualTables(schema);
  const db = new Database(file, { create: true });
  try {
    db.exec('BEGIN');
    await importTableDump(db, sqlPath);
    for (const row of virtual) createSchemaObject(db, row);
    for (const type of ['index', 'view', 'trigger'] as const) {
      for (const row of schema.filter((item) => item.type === type)) createSchemaObject(db, row);
    }
    for (const row of virtual) {
      const name = quoteIdentifier(row.name);
      runOneStatement(db, `INSERT INTO ${name}(${name}) VALUES('rebuild')`);
    }
    const reconstructed = schemaObjects.parse(db.query(SCHEMA_QUERY).all());
    if (JSON.stringify(schema) !== JSON.stringify(reconstructed)) throw new Error('exported database schema does not match its source');
    db.exec('COMMIT');
  } finally { db.close(); }
}
