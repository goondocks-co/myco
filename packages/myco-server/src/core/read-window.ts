/**
 * How much of a Project one run may read in a pass.
 *
 * A run surveys by previews and pulls bodies only for what it means to act on,
 * so the size of a Project sets the cost of a pass over it rather than the size
 * of its writing. The bounds are per task: a digest run reads its material once
 * and writes every tier from it, so its pages and bodies are the tier window's
 * share rather than a sweep's own.
 *
 * One place names which bounds apply to which task. The run tools read a window
 * and never a task name, so a handler cannot grow a second opinion about what a
 * task may read.
 */
import { SPORE_BODY_CHARS, SPORE_FULL_READ_BUDGET, SPORE_PREVIEW_CHARS, MAX_SPORE_LIMIT } from './spores.js';
import {
  DIGEST_FULL_READ_BODY_CHARS, DIGEST_SESSION_PAGE_LIMIT, DIGEST_SPORE_PAGE_LIMIT,
  RUN_SESSION_LABEL_CHARS, RUN_SESSION_SUMMARY_CHARS, RUN_SESSION_TITLE_CHARS, RUN_SESSIONS_MAX_LIMIT,
} from './cortex-input.js';
import { DIGEST_TASK } from './task-inputs.js';

/** The default page of unprocessed prompts, matching the page the extraction outcome reads at a time. */
export const PROMPT_PAGE_LIMIT = 50;

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
  /** The most unprocessed prompts one page carries. */
  promptPage: number;
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
  promptPage: PROMPT_PAGE_LIMIT,
};

const DIGEST: ReadWindow = {
  ...SWEEP,
  sporePage: DIGEST_SPORE_PAGE_LIMIT,
  sporeBodyChars: DIGEST_FULL_READ_BODY_CHARS,
  sessionPage: DIGEST_SESSION_PAGE_LIMIT,
};

/** The window a run of this task reads inside. */
export function readWindowFor(task: string | null): ReadWindow {
  return task === DIGEST_TASK ? DIGEST : SWEEP;
}
