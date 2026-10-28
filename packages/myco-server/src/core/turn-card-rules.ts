/**
 * A turn's trimmed card input and its rule triage, both built by code with no model call.
 *
 * A turn is one top-level prompt and everything recorded under it: its replies, tool calls and plans, and the
 * steering prompts that name it as their parent. The trimmed input keeps every human word, the agent's replies within
 * a budget, each tool call as its name and trimmed arguments, and each result as the head and tail of its held preview
 * plus its error lines. No blob is read and no file body is carried.
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
  const listed = turn.tools.slice(0, B.toolCalls);
  for (const tool of listed) {
    lines.push(`TOOL ${tool.toolName} ${clip((tool.input ?? '').replace(/\s+/g, ' '), B.toolArgChars)}${tool.success ? '' : ' [FAILED]'}`);
    if (tool.errorMessage !== null) lines.push(`  error: ${tool.errorMessage}`);
    if (tool.output !== null && tool.output !== '') lines.push(`  result:\n${trimResult(tool.output)}`);
  }
  const rest = turn.tools.slice(B.toolCalls);
  if (rest.length > 0) {
    const counts = new Map<string, number>();
    for (const tool of rest) counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
    lines.push(`TOOLS NOT LISTED: ${[...counts].map(([name, n]) => `${name}×${n}`).join(', ')}`);
  }
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

/** Prompt text that carries no human writing. */
const MECHANICAL_PROMPT = [
  /^\s*<(task-notification|system-reminder|local-command-stdout|command-message|bash-notification)[\s>]/i,
  /^\s*(continue|go on|go ahead|proceed|keep going|resume|next|ok|okay|yes|y)\s*[.!]?\s*$/i,
  /^\s*\[?(background|scheduled|wake[- ]?up|tick|heartbeat)\b/i,
];
/** Tools that only poll, wait or read status. */
const POLLING_TOOLS = new Set(['TaskOutput', 'BashOutput', 'Monitor', 'ScheduleWakeup', 'ReadNotifications', 'TaskList', 'TaskGet', 'ListAgents', 'CronList', 'TodoWrite', 'TodoRead']);
const POLLING_COMMAND = /^\s*(sleep\b|gh (run (watch|view|list)|pr (checks|view|status)|api\b.*\/(runs|checks|status))|git (status|log|fetch|branch)\b|ls\b|ps\b|tail\b|wc\b|date\b|uptime\b|df\b|herdr\b.*\b(status|list|read)\b|routr\b.*\b(status|usage)\b)/;
/** A polling turn whose human text runs longer than this goes to the model. */
const POLLING_TEXT_CHARS = 280;

function polling(tool: TurnToolInput): boolean {
  if (POLLING_TOOLS.has(tool.toolName)) return true;
  if (tool.toolName !== 'Bash' && tool.toolName !== 'shell' && tool.toolName !== 'exec_command') return false;
  const command = (() => {
    try { const parsed = JSON.parse(tool.input ?? '') as { command?: unknown; cmd?: unknown }; return String(parsed.command ?? parsed.cmd ?? ''); }
    catch { return tool.input ?? ''; }
  })();
  return command.split(/&&|;|\|\|/).every((part) => POLLING_COMMAND.test(part));
}

/**
 * The declared triage rules, in order: the first that matches marks the turn `none` and names itself on the card.
 * A turn holding a failed tool call, a plan or a steering prompt is never triaged by rule.
 */
export const TRIAGE_RULES: readonly { name: string; matches: (turn: TurnInput) => boolean }[] = [
  {
    name: 'no_human_text',
    matches: (turn) => turn.origin === 'system' || turn.origin === 'hook_injected'
      || MECHANICAL_PROMPT.some((pattern) => pattern.test(turn.prompt)),
  },
  {
    name: 'polling_only',
    matches: (turn) => turn.tools.length > 0 && turn.prompt.length <= POLLING_TEXT_CHARS && turn.tools.every(polling),
  },
];

/** The rule that marks this turn `none`, or null when the turn needs a card from the model. */
export function triageTurn(turn: TurnInput): string | null {
  if (turn.steering.length > 0 || turn.plans.length > 0 || turn.tools.some((tool) => !tool.success || tool.errorMessage !== null)) return null;
  return TRIAGE_RULES.find((rule) => rule.matches(turn))?.name ?? null;
}
