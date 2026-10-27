/**
 * How much of a Project one run may read in a pass.
 *
 * A run surveys by previews and pulls bodies only for what it means to act on,
 * so the size of a Project sets the cost of a pass over it rather than the size
 * of its writing. One window serves every retained task: the run tools read a
 * window and never a task name, so a handler cannot grow a second opinion about
 * what a task may read, and a task that needs a window of its own names it here.
 */
import { SPORE_BODY_CHARS, SPORE_FULL_READ_BUDGET, SPORE_PREVIEW_CHARS, MAX_SPORE_LIMIT } from './spores.js';
import { RUN_SESSION_LABEL_CHARS, RUN_SESSION_SUMMARY_CHARS, RUN_SESSION_TITLE_CHARS, RUN_SESSIONS_MAX_LIMIT } from './run-material.js';

/** What one run may read in a pass. */
export interface ReadWindow {
  /** The most spores one inventory page carries. */
  sporePage: number;
  /** How much of a spore's body one inventory line shows. */
  sporePreviewChars: number;
  /** How much of a spore's body one full read serves. */
  sporeBodyChars: number;
  /** How many full spore reads one run is served before the rest answer spent. */
  sporeFullReads: number;
  /** The most sessions one page carries. */
  sessionPage: number;
  sessionTitleChars: number;
  sessionSummaryChars: number;
  sessionLabelChars: number;
}

const SWEEP: ReadWindow = {
  sporePage: MAX_SPORE_LIMIT,
  sporePreviewChars: SPORE_PREVIEW_CHARS,
  sporeBodyChars: SPORE_BODY_CHARS,
  sporeFullReads: SPORE_FULL_READ_BUDGET,
  sessionPage: RUN_SESSIONS_MAX_LIMIT,
  sessionTitleChars: RUN_SESSION_TITLE_CHARS,
  sessionSummaryChars: RUN_SESSION_SUMMARY_CHARS,
  sessionLabelChars: RUN_SESSION_LABEL_CHARS,
};

/** What one turn's trimmed card input may carry, by part: built by code, never by a model, and never a file body. */
export const TURN_INPUT_BUDGETS = {
  /** The prompt and every steering prompt are carried whole up to this many characters each. */
  promptChars: 8_000,
  /** The agent's replies in the turn, verbatim, together. */
  replyChars: 6_000,
  /** One tool call's arguments. */
  toolArgChars: 300,
  /** The head and the tail of one tool result's held preview. */
  resultHeadChars: 400,
  resultTailChars: 400,
  /** Error lines kept from one tool result beyond its head and tail. */
  resultErrorLines: 12,
  /** Tool calls listed in full; the rest are counted by name. */
  toolCalls: 60,
} as const;

/** The trimmed input one card run reads across the turns it cards. */
export const CARD_RUN_INPUT_CHARS = 60_000;
/** The ceiling of one card: a routine turn writes a few lines, a turn with a gotcha writes what it needs up to here. */
export const CARD_MAX_CHARS = 12_000;
/** The cards one learning slice reads; a longer session is learned in several slices. */
export const LEARNING_SLICE_CHARS = 240_000;
/** One raw turn a learning run opens for a high-signal card. */
export const RAW_TURN_CHARS = 40_000;
/** Raw turns one learning run may open. */
export const RAW_TURN_OPENS = 4;

/** The window a run of this task reads inside. */
export function readWindowFor(_task: string | null): ReadWindow {
  return SWEEP;
}
