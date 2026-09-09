/**
 * The instruction a `title-summary` run receives.
 *
 * A worker hands its harness whatever the claim answers, and a harness given
 * nothing ends its turn having done nothing. The prompt is therefore the
 * Deployment's, composed here from the run's own context — the session it was
 * dispatched for and the mode it was asked in — and written in the vocabulary
 * of the tools the run's MCP surface actually serves, which is the only
 * vocabulary a harness on a worker can call.
 *
 * The material is not inlined: the run reads it through `myco_run_sessions`
 * op "material", the way the run's own credential is scoped to do, so the
 * instruction is the same size whatever the session holds.
 */
import { sha256Hex } from '../hash.js';
import { TITLING_REPORT_ACTION } from './run-postconditions.js';
import type { TaskInput } from './task-inputs.js';
import { SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, titlingParamsFrom, type TitlingMode } from './titling-params.js';

const MODE_NOTE: Readonly<Record<TitlingMode, string>> = {
  claim: 'The session has just ended. Its material is the opening prompts, in order. A title already standing is kept: your write is refused and you report that.',
  owner: 'A person asked for a fresh title from the dashboard. Its material is the earliest and the latest prompts, in order, with the middle omitted. Write over whatever title stands.',
};

/** The instruction for the run these parameters describe, or null when they name no session. */
export async function buildTitlingInput(params: Record<string, unknown>): Promise<TaskInput | null> {
  const titling = titlingParamsFrom(params);
  if (titling === null) return null;
  const body = [
    'Title and summarize one session of this project. Budget: a handful of turns.',
    '',
    `Target session: ${titling.session_id}`,
    MODE_NOTE[titling.mode],
    '',
    '## Steps',
    '',
    '1. Call `myco_run_sessions` op "material": the session\'s current title and summary, if any, and its prompt batches in order, each a user prompt with an excerpt of the response. Read the whole arc before writing.',
    '2. Call `myco_run_sessions` op "title" with BOTH `title` and `summary`. The run may write only this session, so no session argument is needed.',
    `3. Close by calling \`myco_run\` op "report" with action "${TITLING_REPORT_ACTION}", a one-line \`summary\` of what you wrote, and \`details\` as a JSON object: {"updated": 1} after a write that took, or {"updated": 0, "reason": "…"} when the write was refused or the material was empty.`,
    '',
    '## Title rules',
    '',
    'The title says WHAT WAS ACCOMPLISHED, not what was asked.',
    '',
    `- Under ${TITLE_MAX_CHARS} characters, sentence case, no trailing period`,
    '- Synthesize from the full arc of prompts, not just the first one',
    '- NEVER use a file path, a directory name or the working directory as the title',
    '- NEVER copy the user\'s first message as the title',
    '- NEVER use a truncated prompt ending in "..."',
    '- Good: "Wave-based parallel executor and per-task provider config"',
    '- Good: "SQLite migration with FTS5 search and vector embeddings"',
    '- Bad: "/git-worktree" (a directory, not a title)',
    '- Bad: "Help me fix the bug in..." (the user\'s prompt)',
    '- Bad: "Working on code" (too vague)',
    '',
    '## Summary rules',
    '',
    `2 to 4 sentences, under ${SUMMARY_MAX_CHARS} characters. Rich in detail: summaries are embedded and searched, so name what was built or fixed, the key files touched, the tools used and the outcome. Cover the FULL arc of the session, not one prompt.`,
  ].join('\n');
  return {
    instruction: body,
    inputHash: await sha256Hex(body),
    counts: { owner: titling.mode === 'owner' },
  };
}
