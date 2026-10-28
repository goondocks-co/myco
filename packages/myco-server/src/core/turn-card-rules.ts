/**
 * A turn's trimmed card input and its rule triage, both built by code with no model call.
 *
 * A turn is one top-level prompt and everything recorded under it: its replies, tool calls and plans, and the
 * steering prompts that name it as their parent. The trimmed input keeps every human word and the agent's replies within
 * a budget. Every failed call and every command anywhere in the turn is kept verbatim first, up to a declared ceiling;
 * routine calls and their results, as the head and tail of the held preview plus its error lines, fill a routine
 * budget, and the rest are counted by name. No blob is read and no file body is carried.
 */
import { TURN_INPUT_BUDGETS as B } from './read-window.js';

export { TURN_QUIET_MS } from '../db/schema-v110.js';

export interface TurnToolInput {
  toolCallId: string;
  toolName: string;
  input: string | null;
  output: string | null;
  success: boolean;
  errorMessage: string | null;
}
export interface TurnInput {
  turnKey: string;
  origin: string;
  prompt: string;
  steering: readonly { promptId: string; text: string }[];
  replies: readonly { responseId: string; text: string }[];
  tools: readonly TurnToolInput[];
  plans: readonly { planKey: string; title: string | null; status: string; content: string | null }[];
}
export interface TrimmedTurn {
  turnKey: string;
  text: string;
  rawChars: number;
  records: readonly (readonly [string, string])[];
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} more characters]`;
const ERROR_LINE = /\b(error|failed|failure|exception|traceback|fatal|denied|refused|cannot|not found|panic)\b|^\s*E\d|✗/i;

function trimResult(output: string): string {
  if (output.length <= B.resultHeadChars + B.resultTailChars) return output;
  const head = output.slice(0, B.resultHeadChars);
  const tail = output.slice(-B.resultTailChars);
  const middle = output.slice(B.resultHeadChars, output.length - B.resultTailChars);
  const errors = middle.split('\n').filter((line) => ERROR_LINE.test(line)).slice(0, B.resultErrorLines);
  return [head, errors.length === 0 ? '[…]' : `[… error lines:]\n${errors.join('\n')}\n[…]`, tail].join('\n');
}

const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command']);

/** The command a shell tool ran, or null for any other tool. */
function commandOf(tool: TurnToolInput): string | null {
  if (!SHELL_TOOLS.has(tool.toolName)) return null;
  try {
    const parsed = JSON.parse(tool.input ?? '') as { command?: unknown; cmd?: unknown };
    return String(parsed.command ?? parsed.cmd ?? '');
  } catch { return tool.input ?? ''; }
}

const failed = (tool: TurnToolInput): boolean => !tool.success || tool.errorMessage !== null;

/**
 * One tool call's lines, split by what the turn must carry. A failed call keeps its arguments, its error and its
 * result's head, tail and error lines; a command keeps its command line. These are kept across the whole turn first.
 * A routine call's line and any successful result are kept while the routine budget lasts.
 */
function toolLines(tool: TurnToolInput): { kept: string[]; routine: string[] } {
  const command = commandOf(tool);
  const args = command ?? (tool.input ?? '').replace(/\s+/g, ' ');
  const line = `TOOL ${tool.toolName} ${clip(args, command !== null || failed(tool) ? B.commandChars : B.toolArgChars)}${failed(tool) ? ' [FAILED]' : ''}`;
  const result = tool.output !== null && tool.output !== '' ? [`  result:\n${trimResult(tool.output)}`] : [];
  if (failed(tool)) return { kept: [line, ...(tool.errorMessage === null ? [] : [`  error: ${clip(tool.errorMessage, B.errorChars)}`]), ...result], routine: [] };
  return command !== null ? { kept: [line], routine: result } : { kept: [], routine: [line, ...result] };
}

/** The turn as one card run reads it. */
export function trimTurn(turn: TurnInput): TrimmedTurn {
  const lines = [`## Turn ${turn.turnKey}`, `PROMPT (${turn.origin}):`, clip(turn.prompt, B.promptChars)];
  for (const steer of turn.steering) lines.push('STEERING PROMPT:', clip(steer.text, B.promptChars));
  let replyRoom = B.replyChars;
  for (const reply of turn.replies) {
    if (replyRoom <= 0) break;
    lines.push('REPLY:', clip(reply.text, replyRoom));
    replyRoom -= reply.text.length;
  }
  const size = (part: readonly string[]) => part.reduce((n, l) => n + l.length + 1, 0);
  const parts = turn.tools.map((tool) => ({ tool, ...toolLines(tool) }));
  let keptRoom = B.exceptionChars;
  let routineRoom = B.routineChars;
  const counted = new Map<string, number>();
  for (const part of parts) {
    const kept = part.kept.length > 0 && size(part.kept) <= keptRoom;
    if (kept) { keptRoom -= size(part.kept); lines.push(...part.kept); }
    const routine = (kept || part.kept.length === 0) && part.routine.length > 0 && size(part.routine) <= routineRoom;
    if (routine) { routineRoom -= size(part.routine); lines.push(...part.routine); }
    if (!kept && !routine) counted.set(part.tool.toolName, (counted.get(part.tool.toolName) ?? 0) + 1);
  }
  if (counted.size > 0) lines.push(`TOOLS NOT LISTED: ${[...counted].map(([name, n]) => `${name}×${n}`).join(', ')}`);
  for (const plan of turn.plans) lines.push(`PLAN ${plan.title ?? plan.planKey} (${plan.status})`);
  const rawChars = turn.prompt.length + turn.steering.reduce((n, s) => n + s.text.length, 0)
    + turn.replies.reduce((n, r) => n + r.text.length, 0)
    + turn.tools.reduce((n, t) => n + (t.input?.length ?? 0) + (t.output?.length ?? 0) + (t.errorMessage?.length ?? 0), 0)
    + turn.plans.reduce((n, p) => n + (p.content?.length ?? 0), 0);
  return {
    turnKey: turn.turnKey,
    text: lines.join('\n'),
    rawChars,
    records: [
      ['prompt', turn.turnKey],
      ...turn.steering.map((s) => ['prompt', s.promptId] as const),
      ...turn.replies.map((r) => ['response', r.responseId] as const),
      ...turn.tools.map((t) => ['tool', t.toolCallId] as const),
      ...turn.plans.map((p) => ['plan', p.planKey] as const),
    ],
  };
}

/** A harness notification envelope, whole. */
const ENVELOPE = /<(task-notification|system-reminder|local-command-stdout|local-command-stderr|command-message|command-name|command-args|bash-notification)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
/** A bare go-ahead. */
const GO_AHEAD = /^(continue|go on|go ahead|proceed|keep going|resume|next|ok|okay|yes|y)\s*[.!]?$/i;

/** Prompt text with no human writing: nothing is left once its notification envelopes are removed but a go-ahead. */
function noHumanText(prompt: string): boolean {
  const left = prompt.replace(ENVELOPE, '').trim();
  return left === '' || GO_AHEAD.test(left);
}
/** Tools that only poll, wait or read status. */
const POLLING_TOOLS = new Set(['TaskOutput', 'BashOutput', 'Monitor', 'ScheduleWakeup', 'ReadNotifications', 'TaskList', 'TaskGet', 'ListAgents', 'CronList', 'TodoWrite', 'TodoRead']);
const POLLING_COMMAND = /^\s*(sleep\b|gh (run (watch|view|list)|pr (checks|view|status)|api\b.*\/(runs|checks|status))|git (status|log|fetch|branch)\b|ls\b|ps\b|tail\b|wc\b|date\b|uptime\b|df\b|herdr\b.*\b(status|list|read)\b|routr\b.*\b(status|usage)\b)/;
/** A polling turn whose human text runs longer than this goes to the model. */
const POLLING_TEXT_CHARS = 280;

function polling(tool: TurnToolInput): boolean {
  if (POLLING_TOOLS.has(tool.toolName)) return true;
  const command = commandOf(tool);
  return command !== null && command.split(/&&|;|\|\|/).every((part) => POLLING_COMMAND.test(part));
}

/**
 * The declared triage rules, in order: the first that matches marks the turn `none` and names itself on the card.
 * A turn holding a failed tool call, a plan or a steering prompt is never triaged by rule.
 */
export const TRIAGE_RULES: readonly { name: string; matches: (turn: TurnInput) => boolean }[] = [
  {
    name: 'no_human_text',
    matches: (turn) => turn.origin === 'system' || turn.origin === 'hook_injected' || noHumanText(turn.prompt),
  },
  {
    name: 'polling_only',
    matches: (turn) => turn.tools.length > 0 && turn.prompt.length <= POLLING_TEXT_CHARS && turn.tools.every(polling),
  },
];

/** The rule that marks this turn `none`, or null when the turn needs a card from the model. */
export function triageTurn(turn: TurnInput): string | null {
  if (turn.steering.length > 0 || turn.plans.length > 0 || turn.tools.some(failed)) return null;
  return TRIAGE_RULES.find((rule) => rule.matches(turn))?.name ?? null;
}
