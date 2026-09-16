import fs from 'node:fs';
import { Database } from 'bun:sqlite';

const MAX_STATEMENT_CHARACTERS = 16 * 1024 * 1024;

/** A statement with leading whitespace and comments removed, so its form is judged on its first real token. */
export function significantStatement(statement: string): string {
  let at = 0;
  for (;;) {
    while (at < statement.length && /\s/.test(statement[at]!)) at += 1;
    if (statement.startsWith('--', at)) {
      const line = statement.indexOf('\n', at);
      at = line < 0 ? statement.length : line + 1;
      continue;
    }
    if (statement.startsWith('/*', at)) {
      const end = statement.indexOf('*/', at + 2);
      at = end < 0 ? statement.length : end + 2;
      continue;
    }
    return statement.slice(at);
  }
}

/** The identifier at `at`, unquoted, and whether a schema qualifier follows it. */
export function identifierAt(sql: string, at: number): { name: string; qualified: boolean } | null {
  let index = at;
  while (index < sql.length && /\s/.test(sql[index]!)) index += 1;
  const opening = sql[index];
  let name = '';
  if (opening === '"' || opening === '`' || opening === '[') {
    const closing = opening === '[' ? ']' : opening;
    index += 1;
    for (;;) {
      const end = sql.indexOf(closing, index);
      if (end < 0) return null;
      name += sql.slice(index, end);
      if (sql[end + 1] === closing && closing !== ']') { name += closing; index = end + 2; continue; }
      index = end + 1;
      break;
    }
  } else {
    const start = index;
    while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
    name = sql.slice(start, index);
    if (name === '') return null;
  }
  while (index < sql.length && /\s/.test(sql[index]!)) index += 1;
  return { name, qualified: sql[index] === '.' };
}

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
  let statement = '';
  let quote = '';
  let literalStart = -1;
  let literalHasNul = false;
  let comment: 'line' | 'block' | '' = '';
  let pending = '';
  const execute = (sql: string): void => {
    refuseForeignDumpStatement(sql);
    if (significantStatement(sql).replace(/;\s*$/, '').trim() === '') return;
    runOneStatement(db, sql);
  };
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  for await (const chunk of input) {
    const text = pending + chunk;
    let offset = 0;
    for (; offset < text.length - 1; offset += 1) {
      const char = text[offset]!;
      const next = text[offset + 1]!;
      statement += char;
      if (statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('D1 export statement exceeds the recovery import limit');
      if (char === '\0') {
        if (quote !== "'") throw new Error('D1 export contains a NUL outside a text literal');
        literalHasNul = true;
        continue;
      }
      if (comment === 'line') { if (char === '\n') comment = ''; continue; }
      if (comment === 'block') {
        if (char === '*' && next === '/') { statement += next; offset += 1; comment = ''; }
        continue;
      }
      if (quote !== '') {
        if (char === quote) {
          if (next === quote && quote !== ']') { statement += next; offset += 1; }
          else {
            if (quote === "'" && literalHasNul) {
              const value = statement.slice(literalStart + 1, -1).replaceAll("''", "'");
              statement = statement.slice(0, literalStart) + `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
              if (statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('D1 export statement exceeds the recovery import limit');
            }
            quote = '';
          }
        }
        continue;
      }
      if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
        comment = char === '-' ? 'line' : 'block'; statement += next; offset += 1;
      } else if (char === "'" || char === '"' || char === '`' || char === '[') {
        quote = char === '[' ? ']' : char;
        if (quote === "'") { literalStart = statement.length - 1; literalHasNul = false; }
      } else if (char === ';') {
        execute(statement);
        statement = '';
      }
    }
    pending = text.slice(offset);
  }
  statement += pending;
  if (quote !== '' || comment === 'block') throw new Error('D1 export ends inside a quoted value or comment');
  if (statement.trim() !== '') execute(statement);
}
