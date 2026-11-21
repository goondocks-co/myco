/**
 * The instruction a `title-summary` run receives.
 *
 * A worker hands its harness whatever the claim answers, and a harness given
 * nothing ends its turn having done nothing. The prompt is therefore the
 * Deployment's, composed here from the run's own context — the session its
 * dispatch names and the mode of the ask — and written in the vocabulary
 * of the tools the run's MCP surface actually serves, which is the only
 * vocabulary a harness on a worker can call.
 *
 * The material is not inlined: the run reads it through `myco_run_sessions`
 * op "material", the way the run's own credential is scoped to do, so the
 * instruction is the same size whatever the session holds.
 */
import { sha256Hex } from '../hash.js';
import { RUN_SKIP_ACTION, TITLING_REPORT_ACTION } from './run-postconditions.js';
import type { TaskInput } from './task-inputs.js';
import { SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, titlingParamsFrom, type TitlingMode } from './titling-params.js';
import { RUN_AUDIT_INSTRUCTION } from './run-audit.js';

const MODE_NOTE: Readonly<Record<TitlingMode, string>> = {
  claim: 'The session has ended or gone quiet. Its bounded material spans the session, including the last instruction turn and its closing reply. A title already standing is kept: your write is refused, and you close with the skip action instead.',
  owner: 'A person asked for a fresh title from the dashboard. Its bounded material spans the opening and closing instruction turns with sampled middle previews. Write over whatever title stands.',
  refresh: 'The session has gone quiet or ended after continuing beyond its recorded title coverage. Its bounded material spans the opening and closing instruction turns with sampled middle previews. Write a title and summary for the whole session so far, over the ones standing.',
};

/** The instruction for the run these parameters describe, or null when they name no session. */
export async function buildTitlingInput(params: Record<string, unknown>): Promise<TaskInput | null> {
  const titling = titlingParamsFrom(params);
  if (titling === null) return null;
  const body = titlingPrompt(titling.session_id, titling.mode);
  return { instruction: body, inputHash: await sha256Hex(body), counts: { owner: titling.mode === 'owner' } };
}

/** The ask for a session and its request mode. */
export function titlingPrompt(sessionId: string, mode: TitlingMode): string {
  return [
    'Title and summarize one session of this project. Budget: a handful of turns.',
    '',
    `Target session: ${sessionId}`,
    MODE_NOTE[mode],
    '',
    '## Steps',
    '',
    '1. Call `myco_run_sessions` op "material": the session\'s current title and summary, if any, and one labelled, bounded excerpt in the `material` field: opening and closing instruction turns with their closing replies, and sampled middle turns. Read the whole arc before writing.',
    '2. Call `myco_run_sessions` op "title" with BOTH `title` and `summary`. The run may write only this session, so no session argument is needed.',
    `3. Close by calling \`myco_run\` op "report": after a write that took, action "${TITLING_REPORT_ACTION}" with a one-line \`summary\` of what you wrote and \`details\` as a serialized JSON object string such as "{\\"updated\\":1}"; when the write was refused, action "${RUN_SKIP_ACTION}" with the refusal in \`summary\`. ${RUN_AUDIT_INSTRUCTION}`,
    '',
    TITLING_RULES,
  ].join('\n');
}

/** Editorial rules shared by direct completions and runner tasks. */
export const TITLING_RULES = [
    '## Title rules',
    '',
    'The title says WHAT WAS ACCOMPLISHED, not what was asked.',
    '',
    `- Under ${TITLE_MAX_CHARS} characters, sentence case, no trailing period`,
    '- Synthesize from the full arc of prompts, not just the first one',
    '- NEVER use a file path, a directory name or the working directory as the title',
    '- NEVER copy the opening instruction as the title',
    '- NEVER use a truncated prompt ending in "..."',
    '- Good: "Wave-based parallel executor and per-task provider config"',
    '- Good: "SQLite migration with FTS5 search and vector embeddings"',
    '- Bad: "/git-worktree" (a directory, not a title)',
    '- Bad: "Help me fix the bug in..." (the opening instruction)',
    '- Bad: "Working on code" (too vague)',
    '',
    '## Summary rules',
    '',
    `2 to 4 sentences, under ${SUMMARY_MAX_CHARS} characters. Rich in detail: summaries are embedded and searched, so name what was built or fixed, the key files touched, the tools used and the outcome. Cover the FULL arc of the session, not one prompt.`,
  'Attribute work to the agent (or its recorded harness name). Instruction labels identify who asked: Person, Another agent, Harness, Myco, or Unknown origin. A request from a person is that person’s request; the work the agent did is the agent’s. When recorded person turns is zero, never call the actor \"the developer\" or \"the team\". Do not invent a person for an unknown origin.',
  'State only what the session shows. If the outcome is still in progress, say so. Do not discuss what was or was not captured.',
].join('\n');
