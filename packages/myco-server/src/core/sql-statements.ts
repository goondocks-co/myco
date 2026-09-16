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

/** How much of a statement a caller keeps: every statement, or only the table definitions among them. */
export type StatementRetention = 'all' | 'definitions';

/** A split in progress. Every field is plain data, so it survives being stored and read back. */
export interface StatementScan {
  statement: string;
  quote: string;
  literalStart: number;
  literalHasNul: boolean;
  comment: 'line' | 'block' | '';
  pending: string;
  /** False once the statement in hand can no longer be a table definition, under `definitions` retention. */
  keeping: boolean;
}

export const newStatementScan = (): StatementScan => ({
  statement: '', quote: '', literalStart: -1, literalHasNul: false, comment: '', pending: '', keeping: true,
});

const CREATE_TABLE = 'CREATE TABLE';
/** How far a statement is judged for definition retention; the deciding prefix is shorter than this. */
const JUDGE_CHARS = CREATE_TABLE.length + 1;

const couldDefineTable = (statement: string): boolean => {
  const head = significantStatement(statement).replace(/\s+/g, ' ').toUpperCase().slice(0, JUDGE_CHARS);
  return CREATE_TABLE.startsWith(head.slice(0, CREATE_TABLE.length)) || head.startsWith(CREATE_TABLE);
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
 * What one retained definition may hold. A reading kept across an interruption is stored, so a statement that cannot
 * be a definition of a table stops being retained rather than growing without a bound; the export then defines fewer
 * tables than the capture named, which the caller refuses.
 */
const DEFINITION_CHARACTERS = 256 * 1024;

function append(scan: StatementScan, char: string, retain: StatementRetention): void {
  if (retain === 'definitions') {
    if (!scan.keeping) return;
    // Leading whitespace and comments say nothing about the form, so a run of either is never carried.
    if (scan.statement === '' && /\s/.test(char)) return;
    if (scan.statement.length > JUDGE_CHARS * 2 && !couldDefineTable(scan.statement)) { scan.keeping = false; scan.statement = ''; return; }
    if (scan.statement.length >= DEFINITION_CHARACTERS) { scan.keeping = false; scan.statement = ''; return; }
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
  if (retain === 'definitions' && !keeping) return;
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
