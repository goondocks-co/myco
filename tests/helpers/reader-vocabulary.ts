/** Words the retired model owned. `\bhost\b` does not match `localhost`. */
export const RETIRED_VOCABULARY = /\b(grove|daemon|host|team|mycelium|symbiont)\b/i;

/** Mechanism words a reader never meets on a page, in any form: "runtimes", "leased", "Observations". */
export const MECHANISM_WORDS = /\b(runtimes?|harness(?:es)?|credentials?|leas(?:e|es|ed|ing)|deployments?|observations?)\b/i;

