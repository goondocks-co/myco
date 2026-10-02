/**
 * The shape of a command, kept for an audit without what it carried.
 *
 * One allow-list rule for every string that may hold a command line: a step's target, an agent's account of the
 * commands it ran and the files it examined, and a harness's own name for a call. A word is kept only where its shape
 * is provably safe; every other word reads `…`, and a run of them reads as one:
 *
 * - the first non-empty line alone, lines broken at `\r`, `\n`, U+2028, U+2029, U+0085, VT and FF;
 * - leading `NAME=value` assignments, of the line, of each command and after `env` and `export`, are dropped;
 * - the program is kept where it is a safe name or a path, and a subcommand only where it is the program's first
 *   positional word, a lowercase name, and the program is one `SUBCOMMAND_PROGRAMS` lists;
 * - a flag keeps its name and never its value: `-x` reads `-x`, `-xVALUE` reads `-x…`, `--name=VALUE` reads
 *   `--name=…`; a word is never read as a flag's value or not, so the word after a flag is kept only where it is a path;
 * - any other argument is kept only where it is a path: it holds a `/` or ends in a file extension, holds no
 *   `@ : = ? &`, and is not key-like taken whole (`safeWord`);
 * - a URL reads as its scheme and host alone;
 * - after a redirection (`<`, `<<`, `<<<`, `>`, `>>`) every word reads `…` up to the next command, and each command of
 *   a list or pipeline (after `|`, `;`, `&&`, `||`) starts again at its program;
 * - a shell's `-c` script is shaped as the command it runs.
 *
 * Masking known access-key shapes (`redactSecrets`) is a second layer a caller applies after this one.
 */

const ELIDED = '…';
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Operators that end one command, so the next word is a program. */
const COMMAND_BREAKS: ReadonlySet<string> = new Set(['|', '||', '&&', ';', '&', '|&', '(', ')', '{', '}', '!']);
/** Redirections that take no word after them. */
const CLOSED_REDIRECTS: ReadonlySet<string> = new Set(['2>&1', '1>&2', '>&2', '>&1', '&>-', '2>&-']);
/** A redirection, alone or with its target glued to it; every word after one, up to the next command, reads `…`. */
const REDIRECT = /^(?:\d*|&)(?:<<<|<<-?|<>|<&?|>>|>[|&]?)/;
const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\s]*)/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PATH_CHARS = /^[A-Za-z0-9._/~+,*{}[\]-]{1,160}$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]{0,30}$/;
const FLAG_NAME = /^--[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_SCRIPT_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const HEX_RUN = /[0-9a-f]{12,}/gi;
const LONG_RUN = 40;
/** A run this short may interleave digits as a name does: `e2e`, `i18n`, `a11y`. */
const SHORT_RUN = 4;
const MIXED_RUN = 24;

/** The programs whose first positional word is a subcommand a reader needs. */
export const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'gh', 'docker', 'cargo', 'go', 'kubectl', 'make', 'pip', 'uv', 'brew', 'myco', 'wrangler',
]);

const transitions = (run: string, test: (a: string, b: string) => boolean): number => {
  let n = 0;
  for (let i = 1; i < run.length; i += 1) if (test(run[i - 1]!, run[i]!)) n += 1;
  return n;
};
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLower = (c: string): boolean => c >= 'a' && c <= 'z';
const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z';

/**
 * Whether a word is key-like, judged over the whole word and not one segment at a time: it holds a UUID or a long hex
 * run, a run of more than four letters and digits that interleaves them (`S3cret`), digits glued to letters in three
 * or more of its segments, a case pattern no name has (`rXUtnFEMI`, `bPxR`), or a long run carrying digits.
 */
export function keyLike(word: string): boolean {
  if (UUID.test(word)) return true;
  for (const [hex] of word.matchAll(HEX_RUN)) if (/\d/.test(hex) && /[a-f]/i.test(hex)) return true;
  if (/[a-z][A-Z][a-z][A-Z]/.test(word) || (word.match(/[a-z][A-Z]{2,}/g)?.length ?? 0) >= 2) return true;
  let interleaved = 0;
  for (const run of word.split(/[^A-Za-z0-9]+/)) {
    if (run.length > LONG_RUN) return true;
    const digitBreaks = transitions(run, (a, b) => isDigit(a) !== isDigit(b));
    if (digitBreaks >= 2 && run.length > SHORT_RUN) return true;
    if (digitBreaks > 0) interleaved += 1;
    if (transitions(run, (a, b) => isLower(a) && isUpper(b)) >= 4) return true;
    if (run.length >= MIXED_RUN && digitBreaks > 0) return true;
  }
  return interleaved >= 3;
}

/** A word that is a safe name or a path as it stands, never one that is key-like. */
const safeName = (word: string): boolean => NAME.test(word) && !keyLike(word);

/** A path: it holds a `/` or ends in a file extension, holds only path characters, and is not key-like taken whole. */
export function pathLike(word: string): boolean {
  return PATH_CHARS.test(word) && (word.includes('/') || EXTENSION.test(word)) && !keyLike(word);
}

/** A URL as its scheme and host, the host read after the last `@` before the path; null for a word that is no URL. */
export function urlShape(word: string): string | null {
  const url = URL_SHAPE.exec(word);
  if (url === null) return null;
  const scheme = url[1]!.toLowerCase();
  const authority = url[2]!;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = hostPort.lastIndexOf(':');
  const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
  const port = colon < 0 ? '' : hostPort.slice(colon + 1);
  if (!HOST.test(host) || !/^\d*$/.test(port)) return `${scheme}://${ELIDED}`;
  return `${scheme}://${host.toLowerCase()}`;
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

/** A word without its enclosing quotes; null where a quoted span never closes or holds its own quote. */
function unquoted(token: string, spaces = false): string | null {
  const first = token[0];
  if (first !== '"' && first !== "'") return token;
  if (token.length < 2 || token.at(-1) !== first) return null;
  const inner = token.slice(1, -1);
  return (!spaces && /\s/.test(inner)) || inner.includes(first) ? null : inner;
}

/** An argument in its allowed shape: a URL as its scheme and host, a path as it stands, anything else `…`. */
function argument(token: string): string {
  const bare = unquoted(token);
  if (bare === null || bare === '') return ELIDED;
  return urlShape(bare) ?? (pathLike(bare) ? bare : ELIDED);
}

/** A program in its allowed shape: a URL as its scheme and host, a safe name or a path as it stands, anything else `…`. */
function program(token: string): string {
  const bare = unquoted(token);
  if (bare === null || bare === '') return ELIDED;
  return urlShape(bare) ?? (safeName(bare) || pathLike(bare) ? bare : ELIDED);
}

/** A flag's name without its value. */
function flag(token: string): string {
  if (token.startsWith('--')) {
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (!FLAG_NAME.test(name) || keyLike(name)) return ELIDED;
    return equals < 0 ? name : `${name}=${ELIDED}`;
  }
  const letter = token[1]!;
  if (!/[A-Za-z0-9]/.test(letter)) return ELIDED;
  return token.length === 2 ? token : `-${letter}${ELIDED}`;
}

/** The words of one command line in their allowed shapes. */
function shapeWords(tokens: readonly string[], depth: number): string[] {
  const out: string[] = [];
  let atProgram = true;
  let name = '';
  let positionals = 0;
  let afterFlag = false;
  let redirected = false;
  let endOfFlags = false;
  let scriptNext = false;
  let assignments = false;
  for (const token of tokens) {
    if (COMMAND_BREAKS.has(token)) {
      out.push(token);
      atProgram = true; name = ''; positionals = 0; afterFlag = false; redirected = false; endOfFlags = false; scriptNext = false;
      continue;
    }
    if (CLOSED_REDIRECTS.has(token)) { out.push(token); continue; }
    const redirect = REDIRECT.exec(token);
    if (redirect !== null) {
      out.push(redirect[0]);
      if (redirect[0] !== token) out.push(ELIDED);
      redirected = true;
      continue;
    }
    if (redirected) { out.push(ELIDED); continue; }
    if ((atProgram || assignments) && ASSIGNMENT.test(token)) continue;
    assignments = false;
    if (atProgram) {
      const shaped = program(token);
      out.push(shaped);
      atProgram = false;
      name = shaped.slice(shaped.lastIndexOf('/') + 1);
      if (name === 'env') { atProgram = true; assignments = true; }
      if (name === 'export') assignments = true;
      continue;
    }
    if (scriptNext && depth === 0) {
      scriptNext = false;
      const script = unquoted(token, true);
      out.push(script === null ? ELIDED : shapeLine(script, depth + 1) ?? ELIDED);
      continue;
    }
    if (!endOfFlags && token === '--') { out.push(token); endOfFlags = true; afterFlag = false; continue; }
    if (!endOfFlags && token.startsWith('-') && token.length > 1) {
      out.push(flag(token));
      afterFlag = true;
      scriptNext = SHELLS.has(name) && SHELL_SCRIPT_FLAG.test(token);
      continue;
    }
    if (!afterFlag) positionals += 1;
    const bare = unquoted(token);
    const subcommand = !afterFlag && positionals === 1 && SUBCOMMAND_PROGRAMS.has(name) && bare !== null && SUBCOMMAND.test(bare) && !keyLike(bare);
    out.push(subcommand ? bare! : argument(token));
    afterFlag = false;
  }
  return out;
}

/** One line in its allowed shape, or null where nothing of it is kept. */
function shapeLine(line: string, depth: number): string | null {
  const out: string[] = [];
  for (const word of shapeWords(words(line), depth)) if (!(word === ELIDED && out.at(-1) === ELIDED)) out.push(word);
  const shaped = out.join(' ').trim();
  return shaped === '' ? null : shaped;
}

/** A command-shaped string in its allowed shape, or null where nothing of it is kept. */
export function commandShape(raw: string): string | null {
  const line = raw.split(LINE_BREAK).find((part) => part.trim() !== '') ?? '';
  return shapeLine(line, 0);
}

/** A path in its allowed shape, or null where the string is not one path. */
export function pathShape(raw: string): string | null {
  const bare = unquoted(raw.trim());
  return bare !== null && pathLike(bare) ? bare : null;
}

/**
 * A name for a call or a stream record, kept only where it is an identifier — letters, digits and `_ . : / -` — and
 * not key-like taken whole.
 */
export function identifierShape(raw: string, max = 128): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > max || !/^[A-Za-z0-9_.:/-]+$/.test(trimmed)) return null;
  return keyLike(trimmed) ? null : trimmed;
}
