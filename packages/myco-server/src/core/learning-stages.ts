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
import { CARD_TASK, claimCardsStatement, settleTurns } from './turn-cards.js';
import { TURN_CARD_PROMPT } from './turn-card-prompt.js';
import { buildLearningAssignment, claimLearningStatement, FRESH_LEARNING_MS, learningHead, LEARNING_TOOL, type LearningAssignment } from './learning-sessions.js';
/** A card run's assignment: the turns it cards, each with the change count its write is guarded by. */
export interface CardAssignment { kind: 'cards'; turns: { turnKey: string; changes: number }[] }

export const learningSubject = (sessionId: string): string => `session:${sessionId}`;
export const cardSubject = (sessionId: string): string => `cards:${sessionId}`;

/** No run of `task` for the session the SQL expression `session` names is in flight. */
const notInFlight = (task: string, subject: (session: string) => string, session: string): string => `NOT EXISTS (SELECT 1
  FROM agent_runs r INDEXED BY idx_agent_runs_task_live WHERE r.task = '${task}' AND r.${IN_FLIGHT_RUN_STATUSES}
    AND r.subject = '${subject('')}' || ${session})`;

/** The ask a session-learning run receives for one slice. */
export function learningPrompt(sessionId: string, assignment: LearningAssignment): string {
  return [
    'Learn durable knowledge from one slice of one coding session. You read the session through its turn cards, never its raw records.',
    '',
    `Target session: ${sessionId}`,
    `This slice: ${assignment.turns.length} cards${assignment.more ? '; later slices of this session follow, so leave the handoff for them' : '; it is the last slice the session has now'}.`,
    ...(assignment.handoff === null ? [] : ['', '## Handoff from the previous slice', '', assignment.handoff]),
    '',
    '## Steps',
    '',
    `1. Call \`${LEARNING_TOOL}\` op "material": the slice's cards in order, each with its \`turn_key\` and \`signal\`. Card fields copy errors, commands, paths and flags exactly; quote them exactly in what you write.`,
    `2. When a high-signal card leaves out a detail a spore needs exactly, call \`${LEARNING_TOOL}\` op "get" with its \`turn_key\` to read that one raw turn. Open a raw turn only for that.`,
    '3. Search before each write and record what is durable, under the standing rules in your instructions file.',
    `4. Call \`${LEARNING_TOOL}\` op "complete" with a \`handoff\` of at most 4 KB for the next slice: open threads, names and decisions later turns may refer to. Completion marks this slice learned.`,
    `5. Close with \`myco_run\` op "report", action "${EXTRACTION_REPORT_ACTION}". ${RUN_AUDIT_INSTRUCTION}`,
  ].join('\n');
}

async function inputHashOf(parts: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

/** A session-learning run's input for this session, or null when no card of it is due. */
export async function buildLearningInput(db: RelationalStore, projectId: string, sessionId: string): Promise<TaskInput | null> {
  const assignment = await buildLearningAssignment(db, projectId, sessionId);
  if (assignment === null) return null;
  return {
    instruction: learningPrompt(sessionId, assignment), instructions: EXTRACTION_RULES,
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
  return session === null ? null : buildLearningInput(env.db, projectId, session);
}

/** A card run's input: what code cannot card in this session's due turns, up to one run's budget. */
export async function buildCardInput(env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, now: number): Promise<TaskInput | null> {
  const settled = await settleTurns(env, projectId, sessionId, now);
  if (settled.forModel.length === 0) return null;
  const assignment: CardAssignment = { kind: 'cards', turns: settled.forModel.map((record) => ({ turnKey: record.turnKey, changes: record.changes })) };
  return {
    instruction: TURN_CARD_PROMPT, inputHash: await inputHashOf([sessionId, assignment]),
    counts: { turns: assignment.turns.length, ruled: settled.ruled, reused: settled.reused },
    context: { session_id: sessionId, assignment },
  };
}

/** The range a stage's eligibility instant falls in: within the fresh window, or older. */
const freshRange = (fresh: boolean, now: number): string => `${fresh ? '>' : '<='} ${Math.floor(now - FRESH_LEARNING_MS)}`;

/**
 * A learning stage. Its due test, head and reassertion are literals apart from the item's identity, so registering it
 * adds no parameters to the pulled write's level and fairness probes.
 */
function learningStage(level: number, fresh: boolean): PulledStage {
  const eligible = (now: number) => `eligible_at <= ${Math.floor(now)} AND eligible_at ${freshRange(fresh, now)} AND ${learningEnabledSql()}`;
  return {
    level, task: EXTRACTION_TASK,
    due: (project, now) => ({
      sql: `EXISTS (SELECT 1 FROM learning_sessions l INDEXED BY idx_learning_eligible WHERE l.project_id = ${project}
        AND l.${eligible(now)} AND ${notInFlight(EXTRACTION_TASK, learningSubject, 'l.session_id')})`,
      params: [],
    }),
    head: async (db, projectId, now) => {
      const row = await db.prepare(`SELECT session_id AS sessionId, eligible_at AS observed FROM learning_sessions l INDEXED BY idx_learning_eligible
        WHERE project_id = ? AND l.${eligible(now)} AND ${notInFlight(EXTRACTION_TASK, learningSubject, 'l.session_id')}
        ORDER BY eligible_at DESC LIMIT 1`).bind(projectId).first<{ sessionId: string; observed: number }>();
      return row === null ? null : { projectId, subject: learningSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    stillHead: (item) => ({
      sql: `EXISTS (SELECT 1 FROM learning_sessions WHERE project_id = ? AND session_id = ? AND eligible_at = ?)`,
      params: [item.projectId, item.key, item.observed],
    }),
    build: (env, item) => buildLearningInput(env.db, item.projectId, item.key),
    claimed: (db, item, _input, run, now) => [claimLearningStatement(db, item.projectId, item.key, now, run)],
  };
}

function cardStage(level: number, fresh: boolean): PulledStage {
  const pending = (now: number) => `state = 'pending' AND due_at <= ${Math.floor(now)} AND due_at ${freshRange(fresh, now)} AND ${learningEnabledSql()}`;
  return {
    level, task: CARD_TASK,
    due: (project, now) => ({
      sql: `EXISTS (SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_due WHERE c.project_id = ${project} AND c.${pending(now)}
        AND ${notInFlight(CARD_TASK, cardSubject, 'c.session_id')})`,
      params: [],
    }),
    head: async (db, projectId, now) => {
      const row = await db.prepare(`SELECT session_id AS sessionId, due_at AS observed FROM turn_cards c INDEXED BY idx_turn_cards_due
        WHERE project_id = ? AND c.${pending(now)} AND ${notInFlight(CARD_TASK, cardSubject, 'c.session_id')}
        ORDER BY due_at DESC LIMIT 1`).bind(projectId).first<{ sessionId: string; observed: number }>();
      return row === null ? null : { projectId, subject: cardSubject(row.sessionId), key: row.sessionId, observed: row.observed };
    },
    stillHead: (item, now) => ({
      sql: `EXISTS (SELECT 1 FROM turn_cards WHERE project_id = ? AND session_id = ? AND state = 'pending' AND due_at <= ${Math.floor(now)})`,
      params: [item.projectId, item.key],
    }),
    build: (env, item, now) => buildCardInput(env, item.projectId, item.key, now),
    claimed: (db, item, input, run, now) => [claimCardsStatement(db, item.projectId, item.key,
      ((input.context?.assignment as CardAssignment | undefined)?.turns ?? []).map((turn) => turn.turnKey), now, run)],
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
