import { learningPolicies } from '../db/runs/pull-policy.js';
import { learningDue, learningHeadSession, learningReadyProjects, stageHead, stageOf } from '../db/learning/ready.js';
import { sessionQuiet } from '../db/learning/progress.js';
import { knowledgeRepositoryInput } from './knowledge-repository.js';
/**
 * The two learning stages as work a claim takes: turn cards on the cheap tier, and session learning on the default
 * tier. Each stage answers its due test, its per-Project head and the input a run of it is built from; both are
 * pulled stages, and session learning is also what a hand start of `extract-curate` builds at its claim.
 *
 * A session with a run of a stage in flight is never that stage's head: the head read skips it, so a busy session
 * never holds up the Project's next one.
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import type { TaskInput } from './task-inputs.js';
import type { PulledStage } from './pulled-stages.js';
import { sha256Hex } from '../hash.js';
import { learningEnabledSql } from '../db/settings/admission.js';
import { EXTRACTION_TASK } from './task-catalogue.js';
import { EXTRACTION_RULES } from './extraction-rules.js';
import { EXTRACTION_REPORT_ACTION } from './run-postconditions.js';
import { RUN_AUDIT_INSTRUCTION } from './run-audit.js';
import { claimCardsWrites as claimCardsStatements, dueCardTurns } from './turn-cards.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { TURN_CARD_PROMPT } from './turn-card-prompt.js';
import {
  buildLearningAssignment,
  claimLearningWrites as claimLearningStatements,
  type LearningAssignment,
} from './learning-sessions.js';
import { LEARNING_TOOL } from './tool-catalogue.js';
/** A card run's assignment: the turns it cards, each with the change count its write is guarded by. */
export interface CardAssignment { kind: 'cards'; turns: { turnKey: string; changes: number }[] }

const learningSubject = (sessionId: string): string => `session:${sessionId}`;
const cardSubject = (sessionId: string): string => `cards:${sessionId}`;

/** The ask a session-learning run receives for one slice: its session, its card count, whether more follow, and the handoff. */
export function learningPrompt(sessionId: string, slice: { cards: string; more: boolean; handoff: string | null }): string {
  return [
    'Learn durable knowledge from one slice of one coding session. You read the session through its turn cards, never its raw records.',
    '',
    `Target session: ${sessionId}`,
    `This slice: ${slice.cards} cards${slice.more ? '; later slices of this session follow, so leave the handoff for them' : '; it is the last slice the session has now'}.`,
    ...(slice.handoff === null ? [] : ['', '## Handoff from the previous slice', '', slice.handoff]),
    '',
    '## Steps',
    '',
    `1. Call \`${LEARNING_TOOL}\` op "material": the slice's cards in order, each with its \`turn_key\` and \`signal\`. Call it again with the answer's \`next_page\` as \`page\` and its \`revision\` until an answer has no \`next_page\`; a \`material_changed\` refusal means restart at page 1. An entry marked \`continues\` goes on under the same \`turn_key\` on the next page. Spore writes and completion wait until every page is read. Card fields copy errors, commands, paths and flags exactly; quote them exactly in what you write.`,
    `2. When a high-signal card leaves out a detail a spore needs exactly, call \`${LEARNING_TOOL}\` op "get" with its \`turn_key\` to read that one raw turn. Open a raw turn only for that.`,
    '3. Search before each write and record what is durable, under the standing rules in your instructions file. Each save answers its `near_matches`: curate them in this run, as those rules say.',
    `4. Call \`${LEARNING_TOOL}\` op "complete" with a \`handoff\` of at most 4 KB for the next slice: open threads, names and decisions later turns may refer to. Completion marks this slice learned.`,
    `5. Close with \`myco_run\` op "report", action "${EXTRACTION_REPORT_ACTION}". ${RUN_AUDIT_INSTRUCTION}`,
  ].join('\n');
}

async function inputHashOf(parts: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

/** A session-learning run's input for this session, or null when no card of it is due. */
async function buildLearningInput(db: RelationalStore, projectId: string, sessionId: string, now = Date.now()): Promise<TaskInput | null> {
  if (!await sessionQuiet(db, projectId, sessionId, now)) return null;
  const assignment = await buildLearningAssignment(db, projectId, sessionId);
  if (assignment === null) return null;
  const source = await knowledgeRepositoryInput(db, projectId);
  return {
    repository: source.repository,
    instruction: learningPrompt(sessionId, { cards: String(assignment.turns.length), more: assignment.more, handoff: assignment.handoff }) + source.instruction, instructions: EXTRACTION_RULES,
    inputHash: await inputHashOf([sessionId, assignment]),
    counts: { cards: assignment.turns.length, more: assignment.more },
    context: { session_id: sessionId, assignment },
    subject: learningSubject(sessionId),
  };
}

/** A hand start of `extract-curate` learns the session it names, or the Project's freshest eligible one, regardless of budget. */
export async function buildHandStartLearning(env: Pick<ServerEnv, 'db'>, projectId: string, now: number, params: Record<string, unknown>): Promise<TaskInput | null> {
  const named = typeof params.session_id === 'string' && params.session_id !== '' ? params.session_id : null;
  const session = named ?? await learningHeadSession(env.db, projectId, now, true) ?? await learningHeadSession(env.db, projectId, now, false);
  return session === null ? null : buildLearningInput(env.db, projectId, session, now);
}

/** A card run's input: this session's turns due for a model, up to one run's budget, read from the catalog alone. */
export async function buildCardInput(env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, now: number): Promise<TaskInput | null> {
  const turns = await dueCardTurns(env.db, projectId, sessionId, now);
  if (turns.length === 0) return null;
  const assignment: CardAssignment = { kind: 'cards', turns };
  return {
    instruction: TURN_CARD_PROMPT, inputHash: await inputHashOf([sessionId, assignment]),
    counts: { turns: turns.length },
    context: { session_id: sessionId, assignment },
  };
}

/**
 * A learning stage. Its due test and head read the stage's ready relation, whose sessions a deadline pass promoted
 * just before this selection; the claim write reasserts the same predicate. Registering a stage adds no parameters to
 * the pulled write's level and fairness probes.
 */
function learningStage(level: number, fresh: boolean): PulledStage {
  return {
    level, task: EXTRACTION_TASK, policy:learningPolicies[1]![Number(fresh)]!, switchedOn: learningEnabledSql(!fresh),
    due: (project, now) => ({ sql: learningDue('learning', fresh, project, String(Math.floor(now))), params: [] }),
    candidates: learningReadyProjects('learning', fresh),
    head: async (db, projectId, now) => {
      const row = await stageHead(db, stageOf('learning', fresh), projectId, now);
      return row === null ? null : { projectId, subject: learningSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    build: (env, item, now) => buildLearningInput(env.db, item.projectId, item.key, now),
    claimed: (db, item, _input, run, now) => claimLearningStatements(item.projectId, item.key, now, run),
  };
}

function cardStage(level: number, fresh: boolean): PulledStage {
  return {
    level, task: CARD_TASK, policy:learningPolicies[0]![Number(fresh)]!, switchedOn: learningEnabledSql(!fresh),
    due: (project, now) => ({ sql: learningDue('cards', fresh, project, String(Math.floor(now))), params: [] }),
    candidates: learningReadyProjects('cards', fresh),
    head: async (db, projectId, now) => {
      const row = await stageHead(db, stageOf('cards', fresh), projectId, now);
      return row === null ? null : { projectId, subject: cardSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    build: (env, item, now) => buildCardInput(env, item.projectId, item.key, now),
    claimed: (db, item, input, run, now) => claimCardsStatements(item.projectId, item.key,
      ((input.context?.assignment as CardAssignment | undefined)?.turns ?? []).map((turn) => turn.turnKey), now, run),
  };
}

/**
 * The learning stages by strict level. Fresh cards come before fresh learning, which needs them; history cards come
 * before history learning for the same reason. Digest and curation hold the levels between.
 */
export const LEARNING_STAGES: readonly PulledStage[] = [
  cardStage(0.5, true),
  learningStage(1, true),
  cardStage(3.5, false),
  learningStage(4, false),
];
