/**
 * The instruction a `turn-cards` run receives. Its text lives here alone, so tuning what a card says is an edit to
 * this file and nothing else.
 */
export const TURN_CARD_PROMPT = `Write one card per turn of a coding session, from the trimmed turns this run is served. Budget: a few turns.

## Steps

1. Call \`myco_run_cards\` op "material". It returns the turns to card, in order, each with its \`turn_key\` and its trimmed input.
2. Call \`myco_run_cards\` op "write" once, with \`cards\`: one entry per card. Every served \`turn_key\` appears in exactly one card's \`turns\`. A run of consecutive mechanical turns (polling, waiting, routine status, "continue") may share one card; every other turn gets its own.
3. Close with \`myco_run\` op "report", action "carded", a one-line \`summary\`.

## What a card is for

A later agent reads only these cards to learn what is worth remembering from the session: gotchas, decisions, fixes that worked, and corrections. It will not see the turn itself unless it asks. A card that drops the exact detail of a gotcha loses it for good.

## Card fields (all required; use "" or [] when empty)

- \`asked\`: what the person asked for, in their words where short.
- \`done\`: what the agent actually did.
- \`outcome\`: how the turn ended: done, partly done, failed, or abandoned.
- \`decisions\`: [{ "decision", "reason" }] choices made and why.
- \`rejected\`: [{ "approach", "reason" }] approaches tried or proposed and dropped, and why.
- \`errors\`: [{ "error", "fix" }] each error with the fix that worked, or "" when none did.
- \`corrections\`: [{ "wrong", "right" }] where the person corrected the agent ("no, don't", "that's wrong"): what was wrong and what was right.
- \`files\`: paths that mattered.
- \`commands\`: commands that mattered, with their flags.
- \`open_questions\`: what was left unresolved.
- \`signal\`: "high" when the turn holds an error and its fix, a decision with a reason, a rejected approach, a correction, or a non-obvious fact about the code or tools; "low" for ordinary work worth a line; "none" for mechanical turns with nothing to learn.

## Exactness

Copy error messages, commands, file paths, flags, versions, config keys and identifiers EXACTLY as they appear in the turn, character for character, inside the field. Never paraphrase, shorten or "clean up" them. A routine turn gets a short card. A turn with an error, a fix, a decision or a correction gets as much detail as it needs.`;

/** A card's fields, in the fixed order every reader sees them. */
export const CARD_FIELDS = ['asked', 'done', 'outcome', 'decisions', 'rejected', 'errors', 'corrections', 'files', 'commands', 'open_questions'] as const;
export const CARD_SIGNALS = ['none', 'low', 'high'] as const;
export type CardSignal = (typeof CARD_SIGNALS)[number];
