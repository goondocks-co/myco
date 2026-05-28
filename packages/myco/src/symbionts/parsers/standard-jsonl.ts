import type { TranscriptTurn, TranscriptImage, ParseJsonlOptions } from '../adapter.js';
import type { TranscriptParser } from './types.js';
import { PROMPT_PREVIEW_CHARS } from '../../constants.js';

/** Claude Code injects [Image: source: /path] text alongside base64 image blocks. Strip these since the actual images are captured as attachments. */
const IMAGE_TEXT_REF_PATTERN = /\[Image: source: [^\]]+\]\n*/g;

/**
 * Standard JSONL transcript parser — handles the flat JSONL format used by
 * Claude Code, Cursor, and other adapters with top-level role fields.
 *
 * Extracts user/assistant turn pairs with text, images, and tool-use counts.
 * Behavior is controlled by ParseJsonlOptions (role field name, timestamp extraction,
 * tool_result skipping, image text reference stripping).
 */
export class StandardJsonlParser implements TranscriptParser {
  constructor(private readonly opts: ParseJsonlOptions) {}

  parseTurns(content: string): TranscriptTurn[] {
    const lines = content.split('\n').filter(Boolean);
    const turns: TranscriptTurn[] = [];
    let current: TranscriptTurn | null = null;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      const role = entry[this.opts.roleField] as string;
      const timestamp = this.opts.extractTimestamp ? (entry.timestamp as string ?? '') : '';

      if (role === 'user') {
        // Skip meta messages (skill injections, deprecation notices, etc.) — they are
        // not real user prompts and should not appear as turns or influence the title.
        if (entry.isMeta === true) continue;

        const msg = entry.message as { content?: Array<{ type: string; text?: string; source?: { type?: string; data?: string; media_type?: string } }> } | undefined;
        const blocks = Array.isArray(msg?.content) ? msg!.content : [];
        const hasText = blocks.some((b) => b.type === 'text' && b.text?.trim());

        if (!hasText) continue;

        if (current) turns.push(current);

        const rawPrompt = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');

        const promptText = (this.opts.stripImageTextRefs ? rawPrompt.replace(IMAGE_TEXT_REF_PATTERN, '') : rawPrompt)
          .trim()
          .slice(0, PROMPT_PREVIEW_CHARS);

        const images: TranscriptImage[] = blocks
          .filter((b) => b.type === 'image' && b.source?.type === 'base64' && b.source.data)
          .map((b) => ({ data: b.source!.data!, mediaType: b.source!.media_type ?? 'image/png' }));

        current = { prompt: promptText, toolCount: 0, timestamp, ...(images.length > 0 ? { images } : {}) };
      } else if (role === 'assistant' && current) {
        const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        if (Array.isArray(msg?.content)) {
          const textParts = msg!.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
          const text = textParts.join('\n').trim();
          if (text) {
            // A single turn can produce multiple assistant entries when text
            // alternates with tool_use (text → tool → text → tool → text → …).
            // Overwriting would lose every text fragment except the last, which
            // is what the UI's stale-looking "response previews" surface: a
            // trailing one-liner instead of the assistant's actual response.
            // Concat with a blank line so the reconstructed turn round-trips
            // multi-block content into prompt_batches.response_summary.
            current.aiResponse = current.aiResponse
              ? `${current.aiResponse}\n\n${text}`
              : text;
          }
          current.toolCount += msg!.content.filter((b) => b.type === 'tool_use').length;
        }
      }
    }

    if (current) turns.push(current);
    return turns;
  }
}
