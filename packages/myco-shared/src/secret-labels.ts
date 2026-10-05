/** Complete name components that introduce a secret value. */
const SECRET_COMPONENTS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw', 'pin', 'secret', 'token',
  'credential', 'credentials', 'creds', 'key', 'apikey', 'accesskey', 'auth', 'authorization', 'bearer',
]);
const MAX_COMPONENT_CHARS = Math.max(...[...SECRET_COMPONENTS].map((name) => name.length));
const LABEL_CHAR = /^[A-Za-z0-9_-]+$/;
const UPPER_SECRET_SUFFIXES = ['PASSWORD', 'PASSWD', 'PASSPHRASE', 'PASSCODE', 'TOKEN', 'SECRET', 'CREDENTIAL', 'CREDENTIALS', 'APIKEY', 'ACCESSKEY', 'AUTHORIZATION'];
const JOINT_WORDS: ReadonlySet<string> = new Set(['is', 'was', 'are']);
const ELISION = '…';
const TOKEN_QUANTITIES: ReadonlySet<string> = new Set(['tokenbudget', 'tokenlimit', 'tokencount', 'tokensbudget', 'tokenslimit', 'tokenscount']);

const URL_OPEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\//y;
const lower = (char: string): boolean => char >= 'a' && char <= 'z';
const upper = (char: string): boolean => char >= 'A' && char <= 'Z';
const digit = (char: string): boolean => char >= '0' && char <= '9';

/** Compatibility characters compared without changing copied prose. */
function character(text: string, at: number): { original: string; comparison: string; end: number } {
  const point = text.codePointAt(at);
  if (point === undefined) return { original: '', comparison: '', end: at };
  const original = String.fromCodePoint(point);
  return { original, comparison: point < 128 ? original : original.normalize('NFKC'), end: at + original.length };
}

/** A line's complete sequence of decimal token quantities, joined only by declared fields. */
function decimalQuantityEnd(text: string, at: number): number | null {
  const spaces = () => { while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r') at += 1; };
  const ended = () => at === text.length || text[at] === '\n';
  while (at < text.length) {
    const numberAt = at;
    while (digit(text[at] ?? '')) at += 1;
    if (at === numberAt) return null;
    spaces();
    if (text[at] === '.') { at += 1; spaces(); return ended() ? at : null; }
    if (ended()) return at;
    if (text[at] !== ';') return null;
    at += 1; spaces();
    if (ended()) return at;
    const nameAt = at;
    while (LABEL_CHAR.test(text[at] ?? '')) at += 1;
    if (!TOKEN_QUANTITIES.has(text.slice(nameAt, at).replace(/[_-]/g, '').toLowerCase())) return null;
    spaces();
    if (text[at] !== ':' && text[at] !== '=') return null;
    at += 1; spaces();
  }
  return null;
}

/** A secret-bearing flag stem, including attached protocol names such as passin and passout. */
export const isSecretFlag = (name: string): boolean => /token|secret|pass|key|auth|credential/i.test(name);

/** CamelCase, acronym, snake_case and kebab-case names tested by complete, bounded components. */
export function isSecretLabel(label: string): boolean {
  label = label.normalize('NFKC');
  let start = 0;
  const secret = (end: number) => {
    if (end - start <= MAX_COMPONENT_CHARS && SECRET_COMPONENTS.has(label.slice(start, end).toLowerCase())) return true;
    const component = label.slice(start, end);
    return /^[A-Z]+$/.test(component) && UPPER_SECRET_SUFFIXES.some((suffix) => component.endsWith(suffix));
  };
  for (let at = 0; at <= label.length; at += 1) {
    const char = label[at] ?? '';
    if (at === label.length || char === '_' || char === '-') {
      if (secret(at)) return true;
      start = at + 1;
    } else {
      if (!LABEL_CHAR.test(char)) return false;
      const prev = label[at - 1] ?? '';
      const next = label[at + 1] ?? '';
      if (at > start && ((upper(char) && (lower(prev) || digit(prev) || (upper(prev) && lower(next)))) || digit(char) !== digit(prev))) {
        if (secret(at)) return true;
        start = at;
      }
    }
  }
  return false;
}

/** Labeled values projected in one scan; quoted values span lines and escaped quotes. */
export function maskSecretLabels(input: string, replacement: string, options: { unquoted: 'line' | 'word'; keepQuotes?: boolean }): string {
  const text = input;
  const out: string[] = [];
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    if (!LABEL_CHAR.test(character(text, at).comparison)) { at = character(text, at).end; continue; }
    if (options.unquoted === 'line' && (at === 0 || /^[\s("'`\[]$/.test(text[at - 1]!))) {
      URL_OPEN.lastIndex = at;
      if (URL_OPEN.exec(text) !== null) {
        while (at < text.length && !/^\s$/.test(text[at]!)) at += 1;
        continue;
      }
    }
    const start = at;
    const label: string[] = [];
    while (at < text.length) {
      const char = character(text, at);
      if (!LABEL_CHAR.test(char.comparison)) break;
      label.push(char.comparison);
      at = char.end;
    }
    if (!isSecretLabel(label.join(''))) continue;
    let valueAt = at;
    if (/^["']$/.test(character(text, valueAt).comparison)) valueAt = character(text, valueAt).end;
    while (/^[ \t]$/.test(character(text, valueAt).comparison)) valueAt = character(text, valueAt).end;
    if (/^[:=|]$/.test(character(text, valueAt).comparison)) valueAt = character(text, valueAt).end;
    else {
      const jointAt = valueAt;
      while (/^[A-Za-z]$/.test(character(text, valueAt).comparison)) valueAt = character(text, valueAt).end;
      if (valueAt - jointAt > 3 || !JOINT_WORDS.has(text.slice(jointAt, valueAt).normalize('NFKC').toLowerCase()) || !/^\s$/.test(text[valueAt] ?? '')) continue;
    }
    while (/^\s$/.test(character(text, valueAt).comparison)) valueAt = character(text, valueAt).end;
    if (valueAt === text.length || text[valueAt] === '|') continue;
    const opener = character(text, valueAt);
    const quote = /^["']$/.test(opener.comparison) ? opener.comparison : '';
    const quantity = quote === '' && TOKEN_QUANTITIES.has(label.join('').replace(/[_-]/g, '').toLowerCase());
    if (quantity) {
      const quantityEnd = decimalQuantityEnd(text, valueAt);
      if (quantityEnd !== null) { at = quantityEnd; continue; }
    }
    let end = valueAt;
    let closed = false;
    if (quote !== '') {
      end = opener.end;
      while (end < text.length) {
        const char = character(text, end);
        end = char.end;
        if (char.comparison === '\\') { end = character(text, end).end; continue; }
        if (char.comparison === quote) { closed = true; break; }
      }
    } else {
      const line = quantity || (options.unquoted === 'line' && text[start] !== '-');
      while (end < text.length && text[end] !== '|' && (line ? text[end] !== '\n' : !/^\s$/.test(text[end]!))) end += 1;
    }
    const keptQuotes = quote !== '' && options.keepQuotes === true;
    const value = text.slice(valueAt + (quote === '' ? 0 : 1), end - (closed ? 1 : 0)).trim();
    if (text[start] !== '-' && (value === ELISION || value === '[REDACTED]')) { at = end; continue; }
    out.push(text.slice(copied, valueAt), `${keptQuotes ? opener.original : ''}${replacement}${keptQuotes && closed ? text[end - 1] : ''}`);
    if (quote === '' && /^\s$/.test(text[end - 1] ?? '')) out.push(' ');
    copied = end;
    at = end;
  }
  out.push(text.slice(copied));
  return out.join('');
}
