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
import { IN_FLIGHT_RUN_STATUSES } from '../db/run-statuses.js';
import { learningEnabledSql } from './settings.js';
import { EXTRACTION_TASK } from './task-catalogue.js';
import { EXTRACTION_RULES } from './extraction-rules.js';
import { EXTRACTION_REPORT_ACTION } from './run-postconditions.js';
import { RUN_AUDIT_INSTRUCTION } from './run-audit.js';
import { CARD_TASK, claimCardsStatements, dueCardTurns } from './turn-cards.js';
import { TURN_CARD_PROMPT } from './turn-card-prompt.js';
import { buildLearningAssignment, claimLearningStatement, learningHead, learningHeadFrom, learningWorkFrom, LEARNING_TOOL, type LearningAssignment } from './learning-sessions.js';
import { learningRangeSql } from './learning-recency.js';
/** A card run's assignment: the turns it cards, each with the change count its write is guarded by. */
export interface CardAssignment { kind: 'cards'; turns: { turnKey: string; changes: number }[] }

export const learningSubject = (sessionId: string): string => `session:${sessionId}`;
export const cardSubject = (sessionId: string): string => `cards:${sessionId}`;

/** No run of `task` for the session the SQL expression `session` names is in flight. */
const notInFlight = (task: string, subject: (session: string) => string, session: string): string => `NOT EXISTS (SELECT 1
  FROM agent_runs r INDEXED BY idx_agent_runs_task_live WHERE r.task = '${task}' AND r.${IN_FLIGHT_RUN_STATUSES}
    AND r.subject = '${subject('')}' || ${session})`;

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
export async function buildLearningInput(db: RelationalStore, projectId: string, sessionId: string, now = Date.now()): Promise<TaskInput | null> {
  const quiet = await db.prepare(`SELECT 1 AS quiet FROM learning_sessions WHERE project_id = ? AND session_id = ? AND quiet_at <= ?`)
    .bind(projectId, sessionId, now).first();
  if (quiet === null) return null;
  const assignment = await buildLearningAssignment(db, projectId, sessionId);
  if (assignment === null) return null;
  return {
    instruction: learningPrompt(sessionId, { cards: String(assignment.turns.length), more: assignment.more, handoff: assignment.handoff }), instructions: EXTRACTION_RULES,
    inputHash: await inputHashOf([sessionId, assignment]),
    counts: { cards: assignment.turns.length, more: assignment.more },
    context: { session_id: sessionId, assignment },
    subject: learningSubject(sessionId),
  };
}

/** A hand start of `extract-curate` learns the session it names, or the Project's freshest eligible one, regardless of budget. */
export async function buildHandStartLearning(env: Pick<ServerEnv, 'db'>, projectId: string, now: number, params: Record<string, unknown>): Promise<TaskInput | null> {
  const named = typeof params.session_id === 'string' && params.session_id !== '' ? params.session_id : null;
  const session = named ?? await learningHead(env.db, projectId, now, true) ?? await learningHead(env.db, projectId, now, false);
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

/** Whether learning is switched on, the switch both learning stages share. */
async function learningSwitchedOn(db: RelationalStore): Promise<boolean> {
  return (await db.prepare(`SELECT ${learningEnabledSql()} AS enabled`).first<{ enabled: number }>())?.enabled === 1;
}

/** History stages are skipped before their due probes unless the Deployment opted in. */
async function historyLearningSwitchedOn(db: RelationalStore): Promise<boolean> {
  return (await db.prepare(`SELECT ${learningEnabledSql(true)} AS enabled`).first<{ enabled: number }>())?.enabled === 1;
}

/**
 * A learning stage. Its due test, head and reassertion are literals apart from the item's identity, so registering it
 * adds no parameters to the pulled write's level and fairness probes.
 */
function learningStage(level: number, fresh: boolean): PulledStage {
  const eligible = (now: number) => `eligible_at IS NOT NULL AND learning_ready_at <= ${Math.floor(now)} AND ${learningRangeSql('learning', fresh, now)} AND ${learningEnabledSql(!fresh)}`;
  return {
    level, task: EXTRACTION_TASK, switchedOn: fresh ? learningSwitchedOn : historyLearningSwitchedOn,
    due: (project, now) => ({
      sql: `EXISTS (SELECT 1 FROM ${learningWorkFrom(project, now, 'learning', fresh)} WHERE l.project_id = ${project}
        AND ${eligible(now)} AND ${notInFlight(EXTRACTION_TASK, learningSubject, 'l.session_id')})`,
      params: [],
    }),
    head: async (db, projectId, now) => {
      const row = await db.prepare(`SELECT session_id AS sessionId, eligible_at AS observed FROM ${learningHeadFrom('learning')}
        WHERE project_id = ? AND ${eligible(now)} AND ${notInFlight(EXTRACTION_TASK, learningSubject, 'l.session_id')}
        ORDER BY source_activity_at DESC, session_id LIMIT 1`).bind(projectId).first<{ sessionId: string; observed: number }>();
      return row === null ? null : { projectId, subject: learningSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    stillHead: (item, now) => ({
      sql: `EXISTS (SELECT 1 FROM learning_sessions WHERE project_id = ? AND session_id = ? AND eligible_at = ? AND ${eligible(now)})`,
      params: [item.projectId, item.key, item.observed],
    }),
    build: (env, item, now) => buildLearningInput(env.db, item.projectId, item.key, now),
    claimed: (db, item, _input, run, now) => [claimLearningStatement(db, item.projectId, item.key, now, run)],
  };
}

function cardStage(level: number, fresh: boolean): PulledStage {
  const pending = (now: number) => `pending_cards > 0 AND card_ready_at <= ${Math.floor(now)} AND ${learningRangeSql('cards', fresh, now)} AND ${learningEnabledSql(!fresh)}
    AND EXISTS (SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_model_due
      WHERE c.project_id = l.project_id AND c.session_id = l.session_id AND c.state = 'pending' AND c.due_at <= ${Math.floor(now)})`;
  return {
    level, task: CARD_TASK, switchedOn: fresh ? learningSwitchedOn : historyLearningSwitchedOn,
    due: (project, now) => ({
      sql: `EXISTS (SELECT 1 FROM ${learningWorkFrom(project, now, 'cards', fresh)} WHERE l.project_id = ${project}
        AND ${pending(now)} AND ${notInFlight(CARD_TASK, cardSubject, 'l.session_id')})`,
      params: [],
    }),
    head: async (db, projectId, now) => {
      const row = await db.prepare(`SELECT session_id AS sessionId, source_activity_at AS observed FROM ${learningHeadFrom('cards')}
        WHERE project_id = ? AND ${pending(now)} AND ${notInFlight(CARD_TASK, cardSubject, 'l.session_id')}
        ORDER BY source_activity_at DESC, session_id LIMIT 1`).bind(projectId).first<{ sessionId: string; observed: number }>();
      return row === null ? null : { projectId, subject: cardSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    stillHead: (item, now) => ({
      sql: `EXISTS (SELECT 1 FROM learning_sessions l WHERE project_id = ? AND session_id = ? AND source_activity_at = ? AND ${pending(now)})`,
      params: [item.projectId, item.key, item.observed],
    }),
    build: (env, item, now) => buildCardInput(env, item.projectId, item.key, now),
    claimed: (db, item, input, run, now) => claimCardsStatements(db, item.projectId, item.key,
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
