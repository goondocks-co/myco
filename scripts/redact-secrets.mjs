// Redaction for text the test runner writes where others read it: hang
// diagnostics land in CI artifacts, and `ps` and `lsof` print whole command
// lines. A value that looks like a credential is replaced before the text is
// written anywhere.

const SECRET_NAME = '[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|credential|api[-_]?key|auth)[A-Za-z0-9_-]*';
/** A value as a command line or header carries it: double-quoted, single-quoted, or bare. */
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s'"]+)`;
const REDACTED = '<redacted>';

/**
 * Replace every credential-like value in `text`: the value of a secret-named
 * flag (`--token x`, `--api-key=x`), of a secret-named `NAME=value` pair or
 * `name: value` header (`x-api-key: x`), a bearer or basic credential, the
 * credentials in a URL, and an invite link's key fragment. Quoted values are
 * replaced whole.
 */
export function redactSecrets(text) {
  return text
    .replace(new RegExp(`\\b((?:Bearer|Basic)\\s+)(?!${REDACTED})${VALUE}`, 'gi'), `$1${REDACTED}`)
    .replace(new RegExp(`(--?${SECRET_NAME})(=|\\s+)(?!${REDACTED})${VALUE}`, 'gi'), `$1$2${REDACTED}`)
    // A header naming its scheme keeps the scheme word; its credential was replaced above.
    .replace(new RegExp(`\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*)(?!${REDACTED}|(?:Bearer|Basic)\\s)${VALUE}`, 'gi'), `$1$2${REDACTED}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, `$1${REDACTED}@`)
    .replace(/#[A-Za-z0-9_-]{32,}/g, `#${REDACTED}`);
}
