/**
 * The prefixes a provider's access key opens with: a word that opens with one, at its start or after punctuation, is a
 * key whatever follows. `keyLike` (`command-shape.ts`) reads a word as key-like by the same table.
 */
export const PROVIDER_KEY_PREFIXES: readonly string[] = ['sk_live_', 'rk_live_', 'sk_test_', 'rk_test_', 'xoxa-', 'xoxb-', 'xoxo-', 'xoxp-', 'xoxr-', 'xoxs-', 'glpat-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'AKIA', 'ASIA', 'AIza', 'sk-'];

const escape = (prefix: string): string => prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
/** A provider key: a listed prefix at the start of a word, and at least eight key characters after it. */
const PROVIDER_KEY = new RegExp(`(^|[^A-Za-z0-9_])(${PROVIDER_KEY_PREFIXES.map(escape).join('|')})[A-Za-z0-9_\\-]{8,}`, 'g');

/** Access-key and password shapes are replaced before stored text is displayed or logged. */
export function redactSecrets(input: string): string {
  return maskSecretLabels(input, '[REDACTED]', { unquoted: 'word' })
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(PROVIDER_KEY, '$1$2[REDACTED]')
    .replace(/auth[_-]?token=[A-Za-z0-9._-]+/gi, 'auth_token=[REDACTED]')
    .replace(/(\bhttps?:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1[REDACTED]@');
}
import { maskSecretLabels } from './secret-labels.js';
