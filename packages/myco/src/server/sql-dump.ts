import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  endStatements, feedStatements, identifierAt, newStatementScan, significantStatement,
} from '@myco-server-worker/core/sql-statements.js';

export { identifierAt, significantStatement };

const TABLE_FORM = /^(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+INTO\s+)/i;
const SEQUENCE_RESET = /^DELETE\s+FROM\s+(?:"sqlite_sequence"|sqlite_sequence)\s*;?\s*$/i;
const DEFER_FOREIGN_KEYS = /^PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;?\s*$/i;

/**
 * Holds one statement to the provider dump contract: the deferred-foreign-key pragma, a table definition, a row
 * insert, or the sequence reset, each naming an unqualified table in the database being built. Any other form,
 * including ATTACH, transaction control and other pragmas, is refused before it reaches SQLite.
 */
export function refuseForeignDumpStatement(statement: string): void {
  const sql = significantStatement(statement);
  if (sql === '' || sql === ';') return;
  if (DEFER_FOREIGN_KEYS.test(sql) || SEQUENCE_RESET.test(sql)) return;
  const form = TABLE_FORM.exec(sql);
  if (form === null) {
    const token = /^[A-Za-z_]+/.exec(sql)?.[0] ?? sql.slice(0, 16);
    throw new Error(`recovery SQL import refuses ${token.toUpperCase()} in an ordinary-table export, which carries only table definitions, rows and the sequence reset`);
  }
  const target = identifierAt(sql, form[0].length);
  if (target === null) throw new Error('recovery SQL import refuses a statement without a table name');
  if (target.qualified) throw new Error(`recovery SQL import refuses a statement naming another schema: ${target.name}`);
}

/** Runs one statement, and only one: SQLite compiles the first statement, so text after it never executes. */
export function runOneStatement(db: Database, sql: string): void {
  const prepared = db.prepare(sql);
  try { prepared.run(); } finally { prepared.finalize(); }
}

/** Stream ordinary-table D1 exports; triggers are supplied separately as complete schema objects. */
export async function importTableDump(db: Database, file: string): Promise<void> {
  const execute = (sql: string): void => {
    refuseForeignDumpStatement(sql);
    if (significantStatement(sql).replace(/;\s*$/, '').trim() === '') return;
    runOneStatement(db, sql);
  };
  const scan = newStatementScan();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  for await (const chunk of input) feedStatements(scan, chunk as string, 'all', execute);
  endStatements(scan, 'all', execute);
}
