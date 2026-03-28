import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';

/**
 * VS Code Copilot stores chat transcripts as JSONL delta files at:
 *   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
 *
 * Format:
 *   Line 0: kind=0 — full initial state { v: { sessionId, requests: [...] } }
 *   Lines 1+: kind=1 (key update) or kind=2 (append to array at key path)
 *
 * Each request has:
 *   - message.text — the user prompt
 *   - response — array of parts accumulated via kind:2 deltas, each part is an
 *     array of objects with `kind` field: 'thinking', 'toolInvocationSerialized',
 *     'markdownContent', 'progressTaskSerialized', or plain text { value: "..." }
 */

/** Response part kinds that represent tool invocations. */
const TOOL_PART_KINDS = new Set(['toolInvocationSerialized', 'toolConfirmation', 'toolMessage']);

export const vscodeCopilotAdapter: SymbiontAdapter = {
  name: 'vscode-copilot',
  displayName: 'VS Code Copilot',
  pluginRootEnvVar: 'VSCODE_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'sessionId',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
  },

  // VS Code doesn't have a predictable transcript directory — hooks provide the path
  findTranscript: () => null,

  parseTurns: (content) => parseVsCodeDeltaJsonl(content),
};

/**
 * Parse VS Code Copilot's delta JSONL transcript format.
 * Replays kind:1 (set) and kind:2 (append) deltas onto the initial state,
 * then extracts turns from the reconstructed requests array.
 */
function parseVsCodeDeltaJsonl(content: string): TranscriptTurn[] {
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  // Parse initial state (kind: 0)
  let initial: VsCodeState;
  try {
    const first = JSON.parse(lines[0]);
    if (first.kind !== 0 || !first.v) return [];
    initial = first.v;
  } catch { return []; }

  // Replay deltas to reconstruct final state
  const state = JSON.parse(JSON.stringify(initial)) as VsCodeState;

  for (let i = 1; i < lines.length; i++) {
    try {
      const delta = JSON.parse(lines[i]);
      if (!delta.k || !Array.isArray(delta.k)) continue;
      applyDelta(state, delta.k, delta.v, delta.kind);
    } catch { /* malformed delta line */ }
  }

  // Extract turns from requests
  return extractTurns(state);
}

/** Apply a single delta to the state. */
function applyDelta(state: Record<string, unknown>, keyPath: string[], value: unknown, kind: number): void {
  let obj: Record<string, unknown> = state;
  for (let j = 0; j < keyPath.length - 1; j++) {
    if (obj[keyPath[j]] === undefined || obj[keyPath[j]] === null) {
      obj[keyPath[j]] = {};
    }
    obj = obj[keyPath[j]] as Record<string, unknown>;
  }
  const lastKey = keyPath[keyPath.length - 1];

  if (kind === 1) {
    // Key update — set value
    obj[lastKey] = value;
  } else if (kind === 2) {
    // Append — push to array
    if (!Array.isArray(obj[lastKey])) obj[lastKey] = [];
    (obj[lastKey] as unknown[]).push(value);
  }
}

/** Extract transcript turns from the reconstructed state. */
function extractTurns(state: VsCodeState): TranscriptTurn[] {
  if (!Array.isArray(state.requests)) return [];

  const turns: TranscriptTurn[] = [];

  for (const req of state.requests) {
    const promptText = req.message?.text?.trim() ?? '';
    if (!promptText) continue;

    const timestamp = req.timestamp ? new Date(req.timestamp).toISOString() : '';

    // Count tool invocations and extract AI response text from response parts
    let toolCount = 0;
    let aiResponse = '';
    const responseParts = normalizeResponseParts(req.response);

    for (const part of responseParts) {
      if (TOOL_PART_KINDS.has(part.kind ?? '')) {
        toolCount++;
      } else if (part.kind === 'markdownContent' || part.kind === 'markdownVuln') {
        // Markdown content is the AI's text response
        const text = part.content?.value ?? part.value ?? '';
        if (text) aiResponse = text;
      } else if (!part.kind && typeof part.value === 'string' && part.value.trim()) {
        // Plain text parts (no kind field) — accumulate as AI response
        aiResponse += (aiResponse ? '\n' : '') + part.value.trim();
      }
    }

    turns.push({
      prompt: promptText.slice(0, PROMPT_PREVIEW_CHARS),
      toolCount,
      timestamp,
      ...(aiResponse ? { aiResponse: aiResponse.trim() } : {}),
    });
  }

  return turns;
}

/**
 * VS Code response parts can be:
 * - An array of arrays (each delta append pushes an array of part objects)
 * - An indexed object { 0: [...], 1: [...] } from the initial state
 * Flatten to a single array of part objects.
 */
function normalizeResponseParts(response: unknown): VsCodeResponsePart[] {
  if (!response) return [];

  // Array of arrays → flatten
  if (Array.isArray(response)) {
    return response.flat().filter((p): p is VsCodeResponsePart => p && typeof p === 'object');
  }

  // Indexed object → extract values and flatten
  if (typeof response === 'object') {
    return Object.values(response)
      .flat()
      .filter((p): p is VsCodeResponsePart => p && typeof p === 'object' && !Array.isArray(p));
  }

  return [];
}

// --- Types ---

interface VsCodeState {
  sessionId?: string;
  requests?: VsCodeRequest[];
  [key: string]: unknown;
}

interface VsCodeRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text?: string };
  response?: unknown;
  [key: string]: unknown;
}

interface VsCodeResponsePart {
  kind?: string;
  value?: string;
  content?: { value?: string };
  [key: string]: unknown;
}
