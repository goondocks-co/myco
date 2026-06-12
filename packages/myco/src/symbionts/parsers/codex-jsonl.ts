import type { TranscriptParser } from './types.js';
import type { TranscriptTurn, TranscriptImage } from '../adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../../constants.js';

/** Parse a data URL (data:<mime>;base64,<data>) into media type and base64 data. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

/**
 * Render the JSON arguments of Codex's `update_plan` function-call tool as
 * markdown so the existing tag-extraction pipeline can persist it as a
 * Plan record. `arguments` is a JSON string of shape:
 *   { "plan": [ { "step": "...", "status": "pending"|"in_progress"|"completed" }, ... ] }
 *
 * Returns null when the args fail to parse or carry no plan steps —
 * caller skips the wrap so no empty plan envelopes are emitted.
 */
function synthesizeUpdatePlanMarkdown(rawArgs: unknown): string | null {
  if (typeof rawArgs !== 'string' || rawArgs.length === 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(rawArgs); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const planRaw = (parsed as { plan?: unknown }).plan;
  if (!Array.isArray(planRaw) || planRaw.length === 0) return null;
  const lines: string[] = ['## Plan', ''];
  for (const item of planRaw) {
    if (!item || typeof item !== 'object') continue;
    const step = String((item as { step?: unknown }).step ?? '').trim();
    if (!step) continue;
    const status = String((item as { status?: unknown }).status ?? 'pending');
    const box = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`- ${box} ${step}`);
  }
  if (lines.length <= 2) return null;
  return lines.join('\n');
}

/**
 * Codex Desktop wraps user prompts with file-mention preambles when screenshots
 * are attached, and injects <image> wrapper tags around image blocks. Strip both
 * so the captured prompt contains only the user's actual text.
 *
 * Preamble pattern:
 *   "# Files mentioned by the user:\n\n## <filename>: <path>\n\n## My request for Codex:\n<actual prompt>"
 *
 * Image wrapper tags (separate input_text blocks):
 *   "<image name=[Image #1]>"  /  "</image>"
 */
const IMAGE_WRAPPER_TAG = /^<\/?image\b[^>]*>$/;
const CODEX_PROMPT_MARKER = '## My request for Codex:\n';

function cleanCodexPromptText(text: string): string {
  // Strip image wrapper tags
  if (IMAGE_WRAPPER_TAG.test(text.trim())) return '';
  // Extract actual prompt from file-mention preamble
  const idx = text.indexOf(CODEX_PROMPT_MARKER);
  if (idx !== -1) return text.slice(idx + CODEX_PROMPT_MARKER.length);
  return text;
}

/** Construction options for {@link CodexJsonlParser}. */
export interface CodexJsonlParserOptions {
  /**
   * User-message prefixes that mark runtime-synthesized system envelopes
   * (manifest-derived — see `symbionts/envelope-prefixes.ts`). An envelope
   * user message folds into the CURRENT turn: it neither replaces the
   * turn's prompt nor starts a new one, so the assistant output that
   * follows it stays attached to the prompt that opened the turn. Without
   * this, a `$skill` expansion (a second user-role response_item) opened a
   * fresh turn that absorbed the real prompt's response, stranding the
   * human batch without a summary.
   */
  envelopePrefixes?: readonly string[];
}

/**
 * Canonical Codex `content[]` → prompt-text routine. Image prompts arrive as
 * multipart content — `<image …>` wrapper `input_text` tags and `input_image`
 * blocks interleaved with the user's real text (which sits LAST, not first).
 * Strips the wrapper tags and joins every remaining text-bearing part.
 *
 * Shared by the transcript parser ({@link CodexJsonlParser.parseTurns}) and
 * the manifest walker (`capture/prompt-kind.ts` via the codex manifest's
 * `textExtraction: joined_text_parts` shape) so both derive IDENTICAL text
 * from the same turn — `populateBatchResponses` prefix-matches walker-stored
 * prompts against parser turns, so any divergence breaks response attribution.
 */
export function extractCodexPromptText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && b.type === 'input_text'
      && typeof b.text === 'string' && b.text.trim().length > 0)
    .map((b) => cleanCodexPromptText(b.text))
    .filter((t) => t.trim());
  return parts.join('\n').trim();
}

/**
 * Parses Codex's nested-payload JSONL transcript format.
 *
 * Codex JSONL entries have the structure:
 *   { type: "response_item", payload: { type: "message", role: "user"|"assistant"|"developer", content: [...] } }
 *
 * Key differences from the standard (Claude Code) format:
 * - Role is at payload.role, not top-level
 * - Content is at payload.content, not message.content
 * - User content blocks use type: "input_text", assistant use type: "output_text"
 * - Tool use is separate "function_call" entries, not nested blocks
 * - Images are data URLs in "input_image" blocks (data:<mime>;base64,<data>), not structured source objects
 * - Codex Desktop wraps prompts with file-mention preambles and <image> tags when screenshots are attached — these are stripped
 * - Non-conversation entries (event_msg, session_meta, turn_context, reasoning) are skipped
 * - System-envelope user messages (manifest-declared prefixes) fold into the current turn
 */
export class CodexJsonlParser implements TranscriptParser {
  private readonly envelopePrefixes: readonly string[];

  constructor(options: CodexJsonlParserOptions = {}) {
    this.envelopePrefixes = options.envelopePrefixes ?? [];
  }

  parseTurns(content: string): TranscriptTurn[] {
    const lines = content.split('\n').filter(Boolean);
    const turns: TranscriptTurn[] = [];
    let current: TranscriptTurn | null = null;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      // Only process response_item entries — skip event_msg, session_meta, turn_context
      if (entry.type !== 'response_item') continue;

      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      const payloadType = payload.type as string;
      const timestamp = (entry.timestamp as string) ?? '';

      // Function calls are separate entries — count them as tool use.
      // The `update_plan` tool is special: it carries Codex's plan-mode
      // updates as structured JSON, the analog of Claude Code's plan
      // mode writing markdown to ~/.claude/plans/. Synthesize an
      // `<update_plan>...</update_plan>` envelope and append it to the
      // current turn's aiResponse so the shared `extractTaggedPlans`
      // pass in stop-processing picks it up (planTags entry below).
      if (payloadType === 'function_call') {
        if (current) {
          current.toolCount++;
          if (payload.name === 'update_plan') {
            const markdown = synthesizeUpdatePlanMarkdown(payload.arguments);
            if (markdown) {
              const wrapped = `<update_plan>\n${markdown}\n</update_plan>`;
              current.aiResponse = current.aiResponse
                ? `${current.aiResponse}\n\n${wrapped}`
                : wrapped;
            }
          }
        }
        continue;
      }

      // Only process message payloads from here
      if (payloadType !== 'message') continue;

      const role = payload.role as string;
      const blocks = Array.isArray(payload.content)
        ? (payload.content as Array<{ type: string; text?: string; image_url?: string }>)
        : [];

      if (role === 'user') {
        const fullPrompt = extractCodexPromptText(blocks);
        if (!fullPrompt) continue;

        // System envelopes are not turn boundaries. Match against the RAW
        // text of the first text block — the same view the live hook and
        // the transcript walker evaluate `prompt_starts_with` rules on.
        // The envelope's text is dropped here (the walker records it as a
        // system-origin batch separately); the turn stays open so the
        // assistant output that follows lands on the prompt that opened it.
        const firstRawText = blocks.find((b) => b.type === 'input_text' && b.text?.trim())?.text ?? '';
        if (this.envelopePrefixes.some((p) => firstRawText.startsWith(p))) continue;

        if (current) turns.push(current);

        const promptText = fullPrompt.slice(0, PROMPT_PREVIEW_CHARS);

        // Extract images from input_image blocks (data URL format: data:<mime>;base64,<data>)
        const images: TranscriptImage[] = [];
        for (const b of blocks) {
          if (b.type === 'input_image' && b.image_url) {
            const parsed = parseDataUrl(b.image_url);
            if (parsed) images.push(parsed);
          }
        }

        current = { prompt: promptText, toolCount: 0, timestamp, ...(images.length > 0 ? { images } : {}) };
      } else if (role === 'assistant' && current) {
        const textParts = blocks
          .filter((b) => b.type === 'output_text' && b.text)
          .map((b) => b.text!);
        const text = textParts.join('\n').trim();
        if (text) {
          // Append rather than overwrite — multi-message turns (text → tool →
          // text → tool → text → …) emit separate assistant entries and
          // overwriting collapses the turn to its last fragment. Matches the
          // `update_plan` envelope path above which already uses this shape.
          current.aiResponse = current.aiResponse
            ? `${current.aiResponse}\n\n${text}`
            : text;
        }
      }
      // role === 'developer' is silently skipped
    }

    if (current) turns.push(current);
    return turns;
  }
}
