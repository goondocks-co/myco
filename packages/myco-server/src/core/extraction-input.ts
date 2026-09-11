/**
 * The instruction an `extract-curate` run receives: the ask, and the standing
 * rules the worker writes into the run's scratch directory as the run's
 * instructions file.
 *
 * The ask is one pass over the prompts nobody has read: read a page, record
 * what it taught as spores, retire what it replaced, mark the page read, close.
 * The Deployment's cursor is the processed mark on each prompt, so a pass that
 * dies mid-page has left every prompt it marked behind it and the next tick
 * reads on from the rest; nothing here is resumed, nothing is phased.
 *
 * The rules are the vocabulary of a good spore and the discipline of a sharp
 * vault — supersede, never duplicate — written once here so the ask stays short
 * and a harness that reads its cwd's instructions file sees them on every turn.
 *
 * Every tool the text names is one the run's MCP surface serves under that name
 * (`tests/myco-server/task-inputs.test.ts`).
 */
import { sha256Hex } from '../hash.js';
import { EXTRACTION_REPORT_ACTION, RUN_SKIP_ACTION } from './run-postconditions.js';
import type { TaskInput } from './task-inputs.js';

/** How many prompts one pass reads; the page the run is told to ask for. */
export const EXTRACTION_PAGE = 20;

/** The standing rules every extraction run works under, as the run's instructions file. */
export const EXTRACTION_RULES = [
  '# Myco extraction run',
  '',
  'You are one run of Myco, this project\'s memory, reading the prompts nobody has read yet and recording what they taught. Your tools are exactly what `tools/list` answers.',
  '',
  '## What a spore is',
  '',
  'A spore is one durable observation a future agent or developer would pay to know before touching this code: a decision and why it was made, a gotcha and what it cost, a pattern this codebase follows, a trade-off it accepted, an architectural invariant. It is not an activity log. "Fixed the retry bug" is not a spore; "The runner\'s retry must wrap only the claim call: wrapping the lease renewal too re-claims a run another worker now holds (packages/myco/src/runner/loop.ts)" is.',
  '',
  'Give every spore an `agent_line`: one line an agent can act on — the situation that triggers it, then the guidance, with the file or symbol it anchors to. It is what a session is served in place of the body, so it has to stand alone. Example: "Before adding a run tool op, declare it in WRITE_OPS if it writes: the dry-run surface and the MCP chokepoint read that list, never the handler (packages/myco-server/src/core/tool-catalogue.ts)." Open the `content` with the same line, then the detail.',
  '',
  'Types: gotcha, bug_fix, decision, discovery, trade_off, cross-cutting, wisdom, pattern, architecture. Tags: two to four, naming the subsystem and the theme.',
  '',
  'Every spore you save or consolidate must name the exact supporting `prompt_id` from the page you read. The server derives its source session; do not substitute the session\'s latest prompt. When several prompts support a finding, name the primary supporting prompt and cite the others in the body.',
  '',
  'Keep durable guidance separate from dated observations. Use the source prompt\'s capture date when describing behavior observed then; do not present an old observation as current policy. Example: "When extraction appears stalled, inspect Deployment power and ended-session eligibility separately. In the September 11 source session, an oldest-first backlog delayed fresh prompts; treat that as a historical observation, not the current scheduling policy."',
  '',
  '## Sharp, not bloated',
  '',
  '- Search before every write. `myco_search` with `type` "spore" finds what already covers the topic; `myco_run_spores` op "get" reads one body in full. Full reads are counted against this run, so read in full only what you mean to act on.',
  '- A topic already covered and nothing new to add: write nothing.',
  '- A topic already covered and the prompts add real detail: save the new spore, then `myco_spores` op "supersede" with `old_spore_id`, `new_spore_id` and a `reason` naming what the new one adds.',
  '- Three or more active spores on one topic: `myco_spores` op "consolidate" with `source_spore_ids`, `consolidated_content` that keeps every concrete detail, `observation_type` "wisdom" and a `reason`.',
  '- A spore the prompts show to be false, with nothing replacing it: `myco_spores` op "obsolete" with `id` and a `reason` saying what invalidated it.',
  '- When in doubt, keep both. A wrong supersession loses knowledge; a duplicate only costs a search.',
  '',
  '## What to skip',
  '',
  'Prompts that are greetings, acknowledgements, pasted errors with no resolution, or routine asks whose answer is in the code itself. A page of twenty prompts commonly yields zero to five spores. Quality over count: one precise observation is worth ten vague ones.',
].join('\n');

/** The one-pass ask. */
export async function buildExtractionInput(): Promise<TaskInput> {
  const body = [
    'Read the prompts nobody has read yet and record what they taught. One pass; budget: about thirty turns.',
    '',
    'The standing rules for what a spore is and how the vault stays sharp are in AGENTS.md in your working directory. Read them first.',
    '',
    '## Steps',
    '',
    `1. Call \`myco_run_prompts\` op "unprocessed" with \`include_text\` true and \`limit\` ${EXTRACTION_PAGE}. Each item carries the prompt id, its session, the person's prompt and an excerpt of the agent's first response. An empty page means there is nothing to read: close at once with action "${RUN_SKIP_ACTION}".`,
    '2. Read the whole page before writing anything, grouped by session, and list the candidate observations. Group candidates by topic: one search per topic, never one per prompt.',
    '3. For each topic, call `myco_search` with `type` "spore" and the topic as the query. Decide per the rules: write nothing, save, save then supersede, consolidate, or obsolete. Writes go through `myco_spores` op "save", "supersede", "consolidate" and "obsolete". Every save or consolidation names its supporting `prompt_id`; date historical observations as the rules describe.',
    '4. Call `myco_run_prompts` op "mark_processed" for EVERY prompt on the page you read, including the ones that taught nothing. A prompt left unmarked is read again by the next pass.',
    `5. Close by calling \`myco_run\` op "report": action "${EXTRACTION_REPORT_ACTION}" with a one-line \`summary\` and \`details\` as a serialized JSON object string such as "{\\"prompts\\":20,\\"created\\":3,\\"superseded\\":1,\\"consolidated\\":0,\\"obsoleted\\":0}". Stop after the report.`,
    '',
    'Partial work stands: a spore saved and a prompt marked before you run out of budget are kept, and the next pass reads on from the prompts you did not mark.',
  ].join('\n');
  return {
    instruction: body,
    instructions: EXTRACTION_RULES,
    inputHash: await sha256Hex(body),
    counts: { page: EXTRACTION_PAGE },
  };
}
