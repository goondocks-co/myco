

/**
 * Directory holding the skills that ship with Myco, relative to the `myco`
 * package root. The plugin bundle, the in-binary bundle and the Deployment's
 * catalogue are all generated from this one tree.
 */
export const SHIPPED_SKILLS_DIR = 'skills';

/**
 * Ceiling on one shipped skill's listing text — `description` plus
 * `when_to_use`, in UTF-8 bytes. A client appends the two and truncates the
 * pair; text past this point is cut mid-sentence and the skill is offered on a
 * fragment.
 */
export const SHIPPED_SKILL_LISTING_MAX_BYTES = 1536;

/**
 * Ceiling on the listing text of every shipped skill added together, in UTF-8
 * bytes. The per-skill cap bounds one entry and says nothing about the sum:
 * every entry is loaded at session start, and a client over its own listing
 * budget drops entries with a debug-log warning rather than an error, so the
 * skill that pushes the total over is the one nobody sees go missing.
 */
export const SHIPPED_SKILL_LISTING_TOTAL_MAX_BYTES = 8192;

/** Ceiling on a shipped skill's line count. Body past this point is a reference file, not a skill. */
export const SHIPPED_SKILL_MAX_LINES = 500;
