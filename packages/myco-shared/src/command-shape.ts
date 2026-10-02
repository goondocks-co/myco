/**
 * The shape of a command, kept for an audit without what it carried.
 *
 * One allow-list rule for every string that may hold a command line: a step's target, an agent's account of the
 * commands it ran and the files it examined, and a harness's own name for a call. What is kept is what a reader needs
 * to see what a command did; everything else becomes `…`:
 *
 * - the first non-empty line alone, so a body on the lines after it (a here-document, an inline script) never stays;
 * - leading `NAME=value` assignments, of the line and after each operator, are dropped;
 * - the program, its subcommands and every path-like or plain-word argument are kept;
 * - a flag's name is kept and its value never is: `--password X` reads `--password …`, `-pX` reads `-p…`,
 *   `--key=X` reads `--key=…`, and the word after a flag reads `…`;
 * - a URL keeps its scheme and host alone;
 * - a quoted argument holding a space, any argument with a character outside the plain set, and any long or
 *   high-entropy word (16 or more characters mixing digits with letters or both cases, or more than 40) read `…`;
 * - shell operators are kept, so a pipeline still reads as one.
 *
 * Masking known access-key shapes (`redactSecrets`) is a second layer a caller applies after this one.
 */

const ELIDED = '…';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OPERATORS: ReadonlySet<string> = new Set(['|', '||', '&&', ';', '&', '|&', '>', '>>', '<', '<<', '<<<', '&>', '2>', '2>>', '2>&1', '1>&2', '>&2', '(', ')']);
const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/@\s]*@)?([A-Za-z0-9.-]*)/;
const PLAIN = /^[A-Za-z0-9._/~+,*?{}[\]-]+$/;
const FLAG_NAME = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const NUMERIC_FLAG = /^-\d+$/;
const WORD_SPLIT = /[/._\-:+,@=~]/;
const LONG_WORD = 40;
const ENTROPIC_WORD = 16;
const LONG_TOKEN = 120;

/** Whether a word looks like a key or a token rather than a name: long, or mixing digits with letters or both cases. */
function entropic(word: string): boolean {
  if (word.length > LONG_WORD) return true;
  if (word.length < ENTROPIC_WORD) return false;
  const digits = /\d/.test(word);
  const letters = /[A-Za-z]/.test(word);
  return (digits && letters) || (/[a-z]/.test(word) && /[A-Z]/.test(word));
}

/** A plain argument as kept, or `…` where it is long, carries a key-like word, or holds a character outside the plain set. */
function plain(token: string): string {
  if (token.length > LONG_TOKEN || !PLAIN.test(token)) return ELIDED;
  return token.split(WORD_SPLIT).some(entropic) ? ELIDED : token;
}

/** The words of one line, a quoted span kept as one word with its quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of line) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (/\s/.test(char)) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** An argument without its enclosing quotes, or `…` where the quoted span holds a space or never closes. */
function unquoted(token: string): string | null {
  const first = token[0];
  if (first !== '"' && first !== "'") return token;
  if (token.length < 2 || token.at(-1) !== first) return null;
  const inner = token.slice(1, -1);
  return /\s/.test(inner) || inner.includes(first) ? null : inner;
}

/** One argument in its allowed shape. */
function argument(token: string): string {
  const bare = unquoted(token);
  if (bare === null || bare === '') return ELIDED;
  const url = URL_SHAPE.exec(bare);
  if (url !== null) return `${url[1]!.toLowerCase()}://${url[2] ?? ''}`;
  const equals = bare.indexOf('=');
  if (equals > 0) return `${plain(bare.slice(0, equals))}=${ELIDED}`;
  return plain(bare);
}

/** A command-shaped string in its allowed shape, or null where nothing of it is kept. */
export function commandShape(raw: string): string | null {
  const line = raw.split(/\r\n|\r|\n/).find((part) => part.trim() !== '') ?? '';
  const out: string[] = [];
  let atProgram = true;
  let flagValue = false;
  let afterEndOfFlags = false;
  for (const token of words(line)) {
    if (OPERATORS.has(token)) {
      out.push(token);
      atProgram = true;
      flagValue = false;
      afterEndOfFlags = false;
      continue;
    }
    if (atProgram && ASSIGNMENT.test(token)) continue;
    if (atProgram) {
      out.push(argument(token));
      atProgram = false;
      continue;
    }
    if (!afterEndOfFlags && token === '--') {
      out.push(token);
      afterEndOfFlags = true;
      flagValue = false;
      continue;
    }
    if (!afterEndOfFlags && token.startsWith('-') && token.length > 1) {
      flagValue = false;
      if (NUMERIC_FLAG.test(token)) { out.push(token); continue; }
      if (token.startsWith('--')) {
        const equals = token.indexOf('=');
        const name = equals < 0 ? token : token.slice(0, equals);
        if (!FLAG_NAME.test(name)) { out.push(ELIDED); continue; }
        out.push(equals < 0 ? name : `${name}=${ELIDED}`);
        flagValue = equals < 0;
        continue;
      }
      const letter = token[1]!;
      if (!/[A-Za-z]/.test(letter)) { out.push(ELIDED); continue; }
      out.push(token.length === 2 ? token : `-${letter}${ELIDED}`);
      flagValue = token.length === 2;
      continue;
    }
    out.push(flagValue ? ELIDED : argument(token));
    flagValue = false;
  }
  const shaped = out.join(' ').trim();
  return shaped === '' ? null : shaped;
}

/**
 * A name for a call or a stream record, kept only where it is an identifier — letters, digits and `_ . : / -` — with no
 * long or high-entropy word in it.
 */
export function identifierShape(raw: string, max = 128): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > max || !/^[A-Za-z0-9_.:/-]+$/.test(trimmed)) return null;
  return trimmed.split(WORD_SPLIT).some(entropic) ? null : trimmed;
}
