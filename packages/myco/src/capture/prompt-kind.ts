/**
 * Per-agent user-prompt kind classification.
 *
 * Both the UserPromptSubmit hook (single-result, tail-read) and the
 * post-turn transcript miner (list-of-results, full-read) feed their
 * parsed events into the same forward-walking state machine here.
 * `extractUserPromptKinds` returns the per-prompt classification list;
 * `classifyNextPromptKind` reads the walker's terminal state to predict
 * what a hypothetical next prompt would be classified as.
 */

export const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user for tool use]';
export const CODEX_INTERRUPT_MARKER = '<turn_aborted>';

/** Return a kind per user prompt seen in the transcript, in order. */
export function extractUserPromptKinds(
  agent: string,
  events: ReadonlyArray<Record<string, unknown>>,
): string[] {
  if (agent === 'claude-code') return walkClaudeCode(events).kinds;
  if (agent === 'codex') return walkCodex(events).kinds;
  return [];
}

/**
 * Classify the kind of a hypothetical next user prompt given the current
 * transcript state + the prompt text (needed for the interrupt-marker check).
 */
export function classifyNextPromptKind(
  agent: string | undefined,
  events: ReadonlyArray<Record<string, unknown>>,
  prompt: string,
): string {
  if (agent === 'claude-code') {
    if (prompt.startsWith(CLAUDE_INTERRUPT_MARKER)) return 'interrupt';
    return walkClaudeCode(events).priorTurnEnded ? 'initial' : 'steering';
  }
  if (agent === 'codex') {
    if (prompt.startsWith(CODEX_INTERRUPT_MARKER)) return 'interrupt';
    const { sawTurnContext, userMessagesInTurn } = walkCodex(events);
    if (!sawTurnContext) return 'initial';
    return userMessagesInTurn > 0 ? 'steering' : 'initial';
  }
  return 'initial';
}

// ─── Claude Code ──────────────────────────────────────────────────────────

interface ClaudeEvent {
  type?: string;
  promptId?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
  };
}

function walkClaudeCode(events: ReadonlyArray<Record<string, unknown>>): {
  kinds: string[];
  priorTurnEnded: boolean;
} {
  const seenPromptIds = new Set<string>();
  const kinds: string[] = [];
  let priorTurnEnded = true;

  for (const raw of events) {
    const e = raw as ClaudeEvent;
    if (e.type === 'user' && e.promptId && !seenPromptIds.has(e.promptId)) {
      const text = e.message?.content?.find((c) => c.type === 'text')?.text ?? '';
      if (!text) continue;
      seenPromptIds.add(e.promptId);
      if (text.startsWith(CLAUDE_INTERRUPT_MARKER)) kinds.push('interrupt');
      else kinds.push(priorTurnEnded ? 'initial' : 'steering');
      priorTurnEnded = false;
    } else if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
      priorTurnEnded = true;
    }
  }

  return { kinds, priorTurnEnded };
}

// ─── Codex ────────────────────────────────────────────────────────────────

interface CodexEvent {
  type?: string;
  payload?: {
    turn_id?: string;
    type?: string;
    role?: string;
    content?: Array<{ text?: string }>;
  };
}

function walkCodex(events: ReadonlyArray<Record<string, unknown>>): {
  kinds: string[];
  sawTurnContext: boolean;
  userMessagesInTurn: number;
} {
  const kinds: string[] = [];
  let currentTurnId: string | null = null;
  let sawTurnContext = false;
  let userMessagesInTurn = 0;

  for (const raw of events) {
    const e = raw as CodexEvent;
    if (e.type === 'turn_context' && e.payload?.turn_id) {
      sawTurnContext = true;
      if (e.payload.turn_id !== currentTurnId) {
        currentTurnId = e.payload.turn_id;
        userMessagesInTurn = 0;
      }
    } else if (
      e.type === 'response_item' &&
      e.payload?.type === 'message' &&
      e.payload.role === 'user'
    ) {
      const text = e.payload.content?.[0]?.text ?? '';
      if (text.startsWith(CODEX_INTERRUPT_MARKER)) kinds.push('interrupt');
      else kinds.push(userMessagesInTurn === 0 ? 'initial' : 'steering');
      userMessagesInTurn++;
    }
  }

  return { kinds, sawTurnContext, userMessagesInTurn };
}
