/**
 * The one SQL statement splitter both recovery paths read an export through: the importer that rebuilds a database
 * from it, and the producer that holds an export to the schema captured before it ran. One state machine decides
 * where a statement ends, which keeps quoted text, comments, NUL literals and the statement ceiling identical on
 * both sides, and keeps `CREATE TABLE` text inside a row value from being read as a definition.
 *
 * The state is plain data, so a producer can carry a half-read statement across an interruption in its checkpoint.
 */

export const MAX_STATEMENT_CHARACTERS = 16 * 1024 * 1024;

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

/**
 * How much of a statement a caller keeps: every statement, the table definitions among them, or the row inserts
 * into a named set of tables.
 */
export type StatementRetention = 'all' | 'definitions' | { rows: readonly string[] };

/** A split in progress. Every field is plain data, so it survives being stored and read back. */
export interface StatementScan {
  statement: string;
  quote: string;
  literalStart: number;
  literalHasNul: boolean;
  comment: 'line' | 'block' | '';
  pending: string;
  /** False once the statement in hand can no longer be one the retention keeps. */
  keeping: boolean;
  /** True once the statement in hand is known to be one the retention keeps, so no ceiling of its own applies. */
  decided: boolean;
}

export const newStatementScan = (): StatementScan => ({
  statement: '', quote: '', literalStart: -1, literalHasNul: false, comment: '', pending: '', keeping: true, decided: false,
});

const INSERT_INTO = 'INSERT INTO';
const CREATE_TABLE = 'CREATE TABLE';
/** How far a statement is judged for definition retention; the deciding prefix is shorter than this. */
const JUDGE_CHARS = CREATE_TABLE.length + 1;

/** True while the significant text cannot yet decide a form: nothing, or a character that may open a comment. */
const undecided = (sql: string): boolean => sql === '' || sql === '-' || sql === '/';

const couldDefineTable = (statement: string): { keep: boolean; decided: boolean } => {
  const sql = significantStatement(statement);
  if (undecided(sql)) return { keep: true, decided: false };
  const head = sql.replace(/\s+/g, ' ').toUpperCase().slice(0, JUDGE_CHARS);
  if (head.startsWith(CREATE_TABLE)) return { keep: true, decided: true };
  return { keep: CREATE_TABLE.startsWith(head.slice(0, CREATE_TABLE.length)), decided: false };
};

/** How far a statement is judged for row retention: the form, then the table name it names. */
const ROW_JUDGE_CHARS = INSERT_INTO.length + 1 + 128;

/** Whether the statement in hand may still be a row insert into one of `tables`. */
const couldInsertRow = (statement: string, tables: readonly string[]): { keep: boolean; decided: boolean } => {
  const sql = significantStatement(statement);
  if (undecided(sql)) return { keep: true, decided: false };
  const head = sql.replace(/\s+/g, ' ').toUpperCase();
  const word = INSERT_INTO.slice(0, 'INSERT'.length);
  if (!(word.startsWith(head.slice(0, word.length)) || head.startsWith(word))) return { keep: false, decided: false };
  const form = INSERT_FORM.exec(sql);
  if (form === null) return { keep: true, decided: false };
  const named = identifierAt(sql, form[0].length);
  if (named === null) return { keep: true, decided: false };
  if (named.qualified) return { keep: false, decided: false };
  if (tables.includes(named.name)) return { keep: true, decided: true };
  return { keep: tables.some((table) => table.startsWith(named.name)), decided: false };
};

const hex = (value: string): string => [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Feeds one chunk of export text through the split, calling `emit` with each complete statement it retains. The
 * last character is held back for the two-character lookahead the next chunk completes.
 */
export function feedStatements(
  scan: StatementScan, chunk: string, retain: StatementRetention, emit: (statement: string) => void,
): void {
  const text = scan.pending + chunk;
  let offset = 0;
  for (; offset < text.length - 1; offset += 1) {
    const char = text[offset]!;
    const next = text[offset + 1]!;
    append(scan, char, retain);
    if (char === '\0') {
      if (scan.quote !== "'") throw new Error('a recovery export contains a NUL outside a text literal');
      scan.literalHasNul = true;
      continue;
    }
    if (scan.comment === 'line') { if (char === '\n') scan.comment = ''; continue; }
    if (scan.comment === 'block') {
      if (char === '*' && next === '/') { append(scan, next, retain); offset += 1; scan.comment = ''; }
      continue;
    }
    if (scan.quote !== '') {
      if (char === scan.quote) {
        if (next === scan.quote && scan.quote !== ']') { append(scan, next, retain); offset += 1; }
        else {
          if (scan.quote === "'" && scan.literalHasNul && retain === 'all') {
            const value = scan.statement.slice(scan.literalStart + 1, -1).replaceAll("''", "'");
            scan.statement = scan.statement.slice(0, scan.literalStart) + `CAST(X'${hex(value)}' AS TEXT)`;
            if (scan.statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('a recovery export statement exceeds the import limit');
          }
          scan.quote = '';
        }
      }
      continue;
    }
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
      scan.comment = char === '-' ? 'line' : 'block';
      append(scan, next, retain);
      offset += 1;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      scan.quote = char === '[' ? ']' : char;
      if (scan.quote === "'") { scan.literalStart = scan.statement.length - 1; scan.literalHasNul = false; }
    } else if (char === ';') {
      end(scan, retain, emit);
    }
  }
  scan.pending = text.slice(offset);
}

/** Closes the split at the end of the export, refusing text that ends mid-value. */
export function endStatements(scan: StatementScan, retain: StatementRetention, emit: (statement: string) => void): void {
  for (const char of scan.pending) append(scan, char, retain);
  scan.pending = '';
  if (scan.quote !== '' || scan.comment === 'block') throw new Error('a recovery export ends inside a quoted value or comment');
  if (scan.statement.trim() !== '') end(scan, retain, emit);
}

/**
 * What one retained statement may hold under a retention that keeps only some of them. A reading kept across an
 * interruption is stored, so a statement that has not yet proved itself stops being retained rather than growing
 * without a bound; the export then carries fewer definitions or rows than the caller expects, which it refuses.
 */
const RETAINED_CHARACTERS = 256 * 1024;

/**
 * How often a statement that is still only whitespace and comments is dropped back to nothing. Leading trivia says
 * nothing about a statement's form, and an export may carry more of it than a retained statement may hold.
 */
const TRIVIA_STRIDE = 4 * 1024;

function append(scan: StatementScan, char: string, retain: StatementRetention): void {
  if (retain !== 'all') {
    if (!scan.keeping) return;
    // Leading whitespace and comments say nothing about the form, so a run of either is never carried.
    if (scan.statement === '' && /\s/.test(char)) return;
    if (!scan.decided) {
      // Dropped only between comments, where nothing partial is left behind.
      if (scan.comment === '' && scan.statement.length > 0 && scan.statement.length % TRIVIA_STRIDE === 0
        && significantStatement(scan.statement) === '') {
        scan.statement = '';
      }
      // Judged inside a bounded window: the form and the name it carries both appear within it.
      const window = retain === 'definitions' ? JUDGE_CHARS * 2 : ROW_JUDGE_CHARS;
      if (scan.statement.length <= window) {
        const judged = retain === 'definitions'
          ? couldDefineTable(scan.statement)
          : couldInsertRow(scan.statement, retain.rows);
        if (!judged.keep) { scan.keeping = false; scan.statement = ''; return; }
        scan.decided = judged.decided;
      }
      // A statement still unjudged may not grow without a bound; one the retention keeps is bounded by the
      // statement ceiling alone, so a large relevant row is read rather than dropped unseen.
      if (!scan.decided && scan.statement.length >= RETAINED_CHARACTERS) { scan.keeping = false; scan.statement = ''; return; }
    }
  }
  scan.statement += char;
  if (scan.statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('a recovery export statement exceeds the import limit');
}

function end(scan: StatementScan, retain: StatementRetention, emit: (statement: string) => void): void {
  const statement = scan.statement;
  scan.statement = '';
  scan.literalStart = -1;
  scan.literalHasNul = false;
  const keeping = scan.keeping;
  scan.keeping = true;
  scan.decided = false;
  if (retain !== 'all' && !keeping) return;
  emit(statement);
}

const TABLE_DEFINITION = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;

/**
 * The table one complete statement defines and the definition text itself, with whitespace outside quoted parts
 * collapsed, so the same definition compares equal however an export lays it out. Any other statement answers null.
 */
export function tableDefinition(statement: string): { name: string; definition: string } | null {
  const sql = significantStatement(statement);
  const form = TABLE_DEFINITION.exec(sql);
  if (form === null) return null;
  const target = identifierAt(sql, form[0].length);
  if (target === null || target.qualified) return null;
  return { name: target.name, definition: normalizeDefinition(sql) };
}

/** Punctuation that stands on its own, so the layout around it carries no meaning. */
const SEPARATORS = new Set(['(', ')', ',']);

/**
 * One definition's comparable form: comments dropped, and runs of whitespace outside quoted text reduced to a single
 * separator. Every byte of a quoted string, identifier or default keeps its own spelling, so two definitions that
 * differ only inside a quoted value compare as the different definitions they are.
 */
export function normalizeDefinition(sql: string): string {
  let out = '';
  let quote = '';
  let separated = false;
  for (let at = 0; at < sql.length; at += 1) {
    const char = sql[at]!;
    const next = sql[at + 1] ?? '';
    if (quote !== '') {
      out += char;
      if (char === quote && next === quote && quote !== ']') { out += next; at += 1; }
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '-' && next === '-') {
      const line = sql.indexOf('\n', at);
      at = line < 0 ? sql.length : line;
      separated = true;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', at + 2);
      at = close < 0 ? sql.length : close + 1;
      separated = true;
      continue;
    }
    if (/\s/.test(char)) { separated = true; continue; }
    if (SEPARATORS.has(char)) { out += char; separated = false; continue; }
    if (separated) {
      if (out !== '' && !SEPARATORS.has(out[out.length - 1]!)) out += ' ';
      separated = false;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') quote = char === '[' ? ']' : char;
    out += char;
  }
  return out.replace(/;$/, '');
}

/** One value of a row insert, as the export wrote it: text, an integer, a real, a blob, or absent. */
export type SqlValue =
  | { kind: 'text'; text: string }
  | { kind: 'integer'; integer: number }
  | { kind: 'real'; real: number }
  | { kind: 'blob'; hex: string }
  | { kind: 'null' };

/** A row insert the export carries: the table it names, the columns it names where it does, and its values. */
export interface InsertedRow {
  table: string;
  columns: string[] | null;
  values: SqlValue[];
}

const INSERT_FORM = /^INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+/i;

/** Reads a parenthesised list, answering each member's text and the offset after the closing bracket. */
function bracketed(sql: string, open: number): { members: string[]; after: number } | null {
  if (sql[open] !== '(') return null;
  const members: string[] = [];
  let member = '';
  let quote = '';
  let depth = 0;
  for (let at = open; at < sql.length; at += 1) {
    const char = sql[at]!;
    const next = sql[at + 1] ?? '';
    if (quote !== '') {
      member += char;
      if (char === quote && next === quote && quote !== ']') { member += next; at += 1; }
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') { quote = char === '[' ? ']' : char; member += char; continue; }
    if (char === '(') {
      depth += 1;
      if (depth === 1) continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) { members.push(member); return { members, after: at + 1 }; }
    }
    if (char === ',' && depth === 1) { members.push(member); member = ''; continue; }
    member += char;
  }
  return null;
}

const BLOB_LITERAL = /^[xX]'([0-9a-fA-F]*)'$/;
const INTEGER_LITERAL = /^[+-]?\d+$/;
const REAL_LITERAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

/** One value as the export wrote it, or null when this reader does not accept the form. */
export function sqlValue(text: string): SqlValue | null {
  const value = text.trim();
  if (value === '') return null;
  if (/^NULL$/i.test(value)) return { kind: 'null' };
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return null;
    const body = value.slice(1, -1);
    // A closing quote inside the body is only legal doubled; an odd run means this is not one literal.
    for (let at = 0; at < body.length; at += 1) {
      if (body[at] !== "'") continue;
      if (body[at + 1] !== "'") return null;
      at += 1;
    }
    return { kind: 'text', text: body.replaceAll("''", "'") };
  }
  const blob = BLOB_LITERAL.exec(value);
  if (blob !== null) return { kind: 'blob', hex: blob[1]!.toLowerCase() };
  if (INTEGER_LITERAL.test(value)) {
    const held = Number(value);
    return Number.isSafeInteger(held) ? { kind: 'integer', integer: held } : null;
  }
  if (REAL_LITERAL.test(value)) return { kind: 'real', real: Number(value) };
  return null;
}

/**
 * What one statement is, as the only reader of SQL text in the Worker answers it: a row it read, a row of a table the
 * caller cares about that it could **not** read, or a statement of no interest. A caller never needs a pattern of
 * its own to tell the second from the third.
 */
export type StatementReading =
  | { kind: 'row'; row: InsertedRow }
  | { kind: 'unreadable'; table: string }
  | { kind: 'other' };

export function readStatement(statement: string, tables: readonly string[] = []): StatementReading {
  const row = insertedRow(statement);
  if (row !== null) return { kind: 'row', row };
  // Comments and whitespace are stripped by the same reader that strips them everywhere else.
  const sql = significantStatement(statement).replace(/;\s*$/, '');
  const form = INSERT_FORM.exec(sql);
  if (form === null) return { kind: 'other' };
  const named = identifierAt(sql, form[0].length);
  if (named === null || named.qualified) return { kind: 'other' };
  return tables.includes(named.name) ? { kind: 'unreadable', table: named.name } : { kind: 'other' };
}

/**
 * The row one complete `INSERT` statement carries, or null for any other statement. A statement whose form or whose
 * values this reader does not accept answers null rather than a guess, so a caller refuses instead of inventing a
 * row: nothing else in the Worker reads a SQL literal.
 */
export function insertedRow(statement: string): InsertedRow | null {
  const sql = significantStatement(statement).replace(/;\s*$/, '');
  const form = INSERT_FORM.exec(sql);
  if (form === null) return null;
  const named = identifierAt(sql, form[0].length);
  if (named === null || named.qualified) return null;
  let at = sql.indexOf(named.name, form[0].length) + named.name.length;
  while (at < sql.length && /[\s"`\]]/.test(sql[at]!)) at += 1;
  let columns: string[] | null = null;
  if (sql[at] === '(') {
    const list = bracketed(sql, at);
    if (list === null) return null;
    const read = list.members.map((member) => identifierAt(member, 0));
    if (read.some((column) => column === null)) return null;
    columns = read.map((column) => column!.name);
    at = list.after;
    while (at < sql.length && /\s/.test(sql[at]!)) at += 1;
  }
  if (!/^VALUES/i.test(sql.slice(at))) return null;
  at += 'VALUES'.length;
  while (at < sql.length && /\s/.test(sql[at]!)) at += 1;
  const list = bracketed(sql, at);
  if (list === null) return null;
  const values = list.members.map(sqlValue);
  if (values.some((value) => value === null)) return null;
  // One row per statement: a multi-row insert is a form this reader does not accept.
  let after = list.after;
  while (after < sql.length && /\s/.test(sql[after]!)) after += 1;
  if (after !== sql.length) return null;
  return { table: named.name, columns, values: values as SqlValue[] };
}

/**
 * The columns one `CREATE TABLE` declares, in the order it declares them, or null when the definition cannot be
 * read. A table constraint — a `PRIMARY KEY (…)`, `FOREIGN KEY`, `CHECK`, `UNIQUE` — is not a column.
 */
export function tableColumns(definition: string): string[] | null {
  const sql = significantStatement(definition).replace(/;\s*$/, '');
  const form = TABLE_DEFINITION.exec(sql);
  if (form === null) return null;
  const named = identifierAt(sql, form[0].length);
  if (named === null || named.qualified) return null;
  const open = sql.indexOf('(', form[0].length);
  if (open < 0) return null;
  const list = bracketed(sql, open);
  if (list === null) return null;
  const columns: string[] = [];
  for (const member of list.members) {
    const text = significantStatement(member).trim();
    if (text === '') continue;
    if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(text)) continue;
    const column = identifierAt(text, 0);
    if (column === null) return null;
    columns.push(column.name);
  }
  return columns.length === 0 ? null : columns;
}
