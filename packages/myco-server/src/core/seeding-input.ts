/**
 * The instruction a `vault-seed` run receives: the ask, and the standing rules
 * the worker writes into the run's scratch directory as the run's instructions
 * file.
 *
 * A seeding run is the one outcome with a checkout. The worker clones the
 * Project's connected repository beside the instructions file, at the path the
 * ask names, and the harness explores it with its own file and shell tools —
 * code and git history both — while every write of knowledge goes over the
 * run's MCP surface. The Deployment builds the ask from the repository the
 * Project has connected, so a Project with none gets no instruction and its
 * dispatch is refused before a row exists.
 *
 * Every Myco tool the text names is one the run's MCP surface serves under that
 * name (`tests/myco-server/task-inputs.test.ts`).
 */
import { sha256Hex } from '../hash.js';
import { MAX_REPOSITORY_HISTORY_DEPTH } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from './adapters.js';
import { repositoryIdentity } from './repositories.js';
import { RUN_SKIP_ACTION, SEEDING_REPORT_ACTION } from './run-postconditions.js';
import type { TaskInput } from './task-inputs.js';

import { SEEDED_SPORE_FLOOR, SEEDING_CHECKOUT_DIR, SEEDING_SPORE_CEILING } from './seeding-params.js';

export { SEEDED_SPORE_FLOOR, SEEDING_CHECKOUT_DIR, SEEDING_SPORE_CEILING };

/** The standing rules every seeding run works under, as the run's instructions file. */
export const SEEDING_RULES = [
  '# Myco seeding run',
  '',
  'You are one run of Myco, this project\'s memory, reading a codebase that has no memory yet and writing its first spores. Your Myco tools are exactly what `tools/list` answers; use your own file and shell tools to read the checkout, read-only. Change nothing in the checkout and push nothing.',
  '',
  '## What a spore is',
  '',
  'A spore is one durable observation a developer or agent new to this code would pay to know: an architectural invariant, a convention the code follows everywhere, a decision and the trade-off behind it, a gotcha that is not obvious from the code. Anchor every one to a path, a symbol or a commit. "Uses TypeScript" is not a spore; "Every daemon API handler takes a ProjectScope rather than a project id string: the scope binds the database, the project and the machine at once, and a handler that takes a bare id reaches the wrong vault under a second Grove (packages/myco/src/daemon/api/*.ts)" is.',
  '',
  'Give every spore an `agent_line`: one line an agent can act on — the situation that triggers it, then the guidance, then the anchor. It is what a session is served in place of the body, so it has to stand alone. Open the `content` with the same line, then the detail.',
  '',
  'Types: architecture, pattern, decision, trade_off, gotcha, cross-cutting, wisdom. Tags: two to four, naming the subsystem and the theme. Do not pass `session_id`: this run names no session.',
  '',
  '## What git history is for',
  '',
  `Run each Git read as a separate shell tool call using the literal relative path: \`git -C ${SEEDING_CHECKOUT_DIR} <command>\`. Do not use shell variables, pipelines, command chains, or \`cd\`; those forms require permissions this unattended run does not hold. Use dedicated file read, glob and search tools when your harness provides them.`,
  '',
  `The log says what the code cannot: which areas churn, which decisions were reversed, what a large refactor replaced and why its message says so. Read \`git -C ${SEEDING_CHECKOUT_DIR} log --oneline -n ${MAX_REPOSITORY_HISTORY_DEPTH}\`, \`git -C ${SEEDING_CHECKOUT_DIR} shortlog -sn --no-merges HEAD\`, and the messages of the largest recent commits. A commit message that explains a reversal is a decision spore; a file rewritten three times is a gotcha worth naming.`,
  '',
  '## What to skip',
  '',
  'Boilerplate, manifest fields, generated code, anything the README already says, generic advice, and implementation detail that changes weekly. Fewer, sharper spores beat many: ten precise observations seed a project better than forty vague ones.',
].join('\n');

/** The one-pass ask for the repository this Project has connected, or null where it has connected none. */
export async function buildSeedingInput(env: ServerEnv, projectId: string): Promise<TaskInput | null> {
  const repository = await repositoryIdentity(env.db, { projectId });
  if (repository === null) return null;
  const body = [
    `Seed this project's memory from its code and git history. The repository ${repository.url} (branch ${repository.branch}) is checked out, read-only, at ./${SEEDING_CHECKOUT_DIR} under your working directory. One pass; budget: about eighty turns.`,
    '',
    'The standing rules for what a spore is and what to skip are in AGENTS.md in your working directory. Read them first.',
    '',
    '## Steps',
    '',
    `1. Call \`myco_run_spores\` op "list" once. A \`total\` of ${SEEDED_SPORE_FLOOR} or more active spores means this project is already seeded: close at once with action "${RUN_SKIP_ACTION}" and say so in the summary.`,
    `2. Orient, in about ten tool calls: the README, the primary manifest, the top-level layout, the docs directory if there is one, and the git history as the rules describe. Name three to eight themes worth drilling into: architectural layers, cross-cutting concepts, integration points, conventions.`,
    '3. Drill into each theme with searches and targeted reads of the two to four most informative files. Collect concrete observations anchored to paths, symbols or commits. Prefer cross-cutting modules over leaf files.',
    `4. For each observation, call \`myco_search\` with \`type\` "spore" first; a Project being seeded is rarely empty of an earlier pass. Then \`myco_spores\` op "save" with \`content\`, \`type\` and \`tags\`. Write between ten and ${SEEDING_SPORE_CEILING} spores; past the ceiling, keep the most load-bearing and drop the rest.`,
    `5. Close by calling \`myco_run\` op "report": action "${SEEDING_REPORT_ACTION}" with a one-line \`summary\` and \`details\` as a serialized JSON object string such as "{\\"spores\\":24,\\"themes\\":6,\\"thin_coverage\\":[\\"deploy\\"]}", where thin_coverage names the themes that yielded fewer than three observations. Stop after the report.`,
    '',
    'Partial work stands: every spore saved before you run out of budget is kept.',
  ].join('\n');
  return {
    instruction: body,
    instructions: SEEDING_RULES,
    inputHash: await sha256Hex(body),
    counts: { ceiling: SEEDING_SPORE_CEILING },
    repository: { ...repository, historyDepth: MAX_REPOSITORY_HISTORY_DEPTH },
  };
}
