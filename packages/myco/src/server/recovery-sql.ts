import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { syncDirectoryForDurability } from '@myco/utils/atomic-write.js';
import { schemaObjects, SCHEMA_QUERY, quoteIdentifier as identifier, recoverableVirtualTables } from './recovery-schema.js';
import path from 'node:path';

const MAX_STATEMENT_BYTES = 90_000;
const VALUE_CHUNK_BYTES = 16_000;
const VALUE_TABLE = '__myco_recovery_value';

type SchemaObject = ReturnType<typeof schemaObjects.parse>[number];

/** Parent tables precede their children; self-references retain the source's row order. */
function tableOrder(db: Database, schema: SchemaObject[]): SchemaObject[] {
  const remaining = new Map(schema.filter((row) => row.storage === 'table').map((row) => [row.name, row]));
  const parents = new Map([...remaining.keys()].map((name) => [name,
    db.query<{ table: string }, []>(`PRAGMA foreign_key_list(${identifier(name)})`).all().map((row) => row.table),
  ]));
  const result: SchemaObject[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((row) => parents.get(row.name)!.every((name) => name === row.name || !remaining.has(name)));
    if (ready.length === 0) throw new Error('hosted recovery cannot order cyclic table dependencies');
    for (const row of ready) { result.push(row); remaining.delete(row.name); }
  }
  return result;
}

/** Emit a private, bounded D1 import from a closed SQLite recovery snapshot. */
export function writeRecoverySql(databasePath: string, destination: string): { tables: number; rows: number; statements: number; bytes: number } {
  if (fs.existsSync(destination)) throw new Error('recovery SQL destination already exists');
  const db = new Database(databasePath, { readonly: true, safeIntegers: true });
  const partial = destination + '.partial';
  let fd: number | undefined;
  let ownsPartial = false;
  const result = { tables: 0, rows: 0, statements: 0, bytes: 0 };
  try {
    db.exec('BEGIN');
    const schema = schemaObjects.parse(db.query(SCHEMA_QUERY).all());
    if (schema.some((row) => row.name === VALUE_TABLE)) throw new Error('recovery snapshot uses the reserved value table');
    const virtual = recoverableVirtualTables(schema);
    const tables = tableOrder(db, schema);
    result.tables = tables.length;
    if (tables.length === 0) throw new Error('recovery snapshot has no ordinary tables');
    fd = fs.openSync(partial, 'wx', 0o600);
    ownsPartial = true;
    const emit = (sql: string) => {
      const bytes = Buffer.from(sql + ';\n');
      if (bytes.length > MAX_STATEMENT_BYTES) throw new Error('recovery SQL statement exceeds the hosted import limit');
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(fd!, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error('recovery SQL write made no progress');
        offset += written;
      }
      result.statements++;
      result.bytes += bytes.length;
    };
    const value = (input: unknown, slot: number): string => {
      if (input === null) return 'NULL';
      if (typeof input === 'bigint') return String(input);
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) throw new Error('hosted recovery cannot encode a non-finite number');
        return Number.isInteger(input) ? input.toFixed(1) : String(input);
      }
      if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('unsupported recovery SQL value');
      const bytes = Buffer.from(input);
      let expression: string;
      if (bytes.length <= VALUE_CHUNK_BYTES) expression = `X'${bytes.toString('hex')}'`;
      else {
        emit(`INSERT OR REPLACE INTO ${VALUE_TABLE} VALUES(${slot},X'')`);
        for (let offset = 0; offset < bytes.length; offset += VALUE_CHUNK_BYTES) {
          emit(`UPDATE ${VALUE_TABLE} SET value=CAST(value||X'${bytes.subarray(offset, offset + VALUE_CHUNK_BYTES).toString('hex')}' AS BLOB) WHERE slot=${slot}`);
        }
        expression = `(SELECT value FROM ${VALUE_TABLE} WHERE slot=${slot})`;
      }
      return typeof input === 'string' ? `CAST(${expression} AS TEXT)` : expression;
    };
    emit('PRAGMA defer_foreign_keys=ON');
    for (const table of tables) emit(table.sql);
    const unique = new Set(schema.filter((row) => row.type === 'index' && /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(row.sql)).map((row) => row.name));
    for (const row of schema) if (unique.has(row.name)) emit(row.sql);
    emit(`CREATE TABLE ${VALUE_TABLE}(slot INTEGER PRIMARY KEY,value BLOB)`);
    for (const table of tables) {
      const columns = db.query<{ name: string; hidden: bigint }, []>(`PRAGMA table_xinfo(${identifier(table.name)})`).all()
        .filter((row) => row.hidden === 0n).map((row) => row.name);
      const withoutRowid = db.query<{ wr: bigint }, [string]>('SELECT wr FROM pragma_table_list WHERE schema=\'main\' AND name=?').get(table.name)!.wr;
      if (withoutRowid === 0n) {
        const declared = new Set(columns.map((name) => name.toLowerCase()));
        const rowid = ['rowid', '_rowid_', 'oid'].find((name) => !declared.has(name));
        if (rowid === undefined) throw new Error('hosted recovery cannot address the source rowid');
        columns.unshift(rowid);
      }
      const names = columns.map(identifier).join(',');
      const selected = columns.map((name) => `${identifier(name)} AS ${identifier(name)}`).join(',');
      for (const row of db.query<Record<string, unknown>, []>(`SELECT ${selected} FROM ${identifier(table.name)}`).iterate()) {
        emit(`INSERT INTO ${identifier(table.name)}(${names}) VALUES(${columns.map((name, slot) => value(row[name], slot)).join(',')})`);
        result.rows++;
      }
    }
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get() !== null) {
      emit('DELETE FROM sqlite_sequence');
      for (const row of db.query<{ name: string; seq: bigint }, []>('SELECT name,seq FROM sqlite_sequence').iterate()) {
        emit(`INSERT INTO sqlite_sequence VALUES(${value(row.name, 0)},${row.seq})`);
      }
    }
    emit(`DROP TABLE ${VALUE_TABLE}`);
    for (const row of virtual) emit(row.sql);
    for (const type of ['index', 'view', 'trigger']) {
      for (const row of schema) if (row.type === type && !unique.has(row.name)) emit(row.sql);
    }
    for (const row of virtual) emit(`INSERT INTO ${identifier(row.name)}(${identifier(row.name)}) VALUES('rebuild')`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(partial, destination);
    fs.unlinkSync(partial);
    ownsPartial = false;
    syncDirectoryForDurability(path.dirname(destination));
    return result;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (ownsPartial) fs.unlinkSync(partial);
    db.close();
  }
}
