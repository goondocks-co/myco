/** Words the retired model owned. `\bhost\b` does not match `localhost`. */
export const RETIRED_VOCABULARY = /\b(grove|daemon|host|team|mycelium|symbiont)\b/i;

/** A word whose first letter may be either case. */
const word = (w: string): string => `[${w[0]!.toUpperCase()}${w[0]}]${w.slice(1)}`;
const WORDS = [
  'runtimes?', 'harness(?:es)?', 'credentials?', 'leas(?:e|es|ed|ing)', 'deployments?', 'observations?',
  'bindings?', 'producers?', 'probes?', 're-?index(?:es|ed|ing)?', 'vectors?',
];

/**
 * Mechanism words a reader never meets on a page, in any form: "runtimes", "leased", "Observations", "binding",
 * "re-index", and JSON named as a format rather than in a path or media type.
 */
export const MECHANISM_WORDS = new RegExp(`\\b(?:${WORDS.map(word).join('|')})\\b|(?<![\\w./-])JSON\\b`);
