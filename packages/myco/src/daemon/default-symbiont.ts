/**
 * The 1.4 daemon's harness for a hook event that names none: 1.4's hook commands always named theirs, and its daemon
 * attributed anything that did not to Claude Code. 2.0 attributes nothing it is not told (a hook naming no harness is
 * refused), so only 1.4 code reads this; it goes with the daemon (#1170).
 */
export const DEFAULT_SYMBIONT_NAME = 'claude-code';
