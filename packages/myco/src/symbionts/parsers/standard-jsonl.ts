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

      // Queued steering prompts (Claude Code's Esc→queue UI) land as
      // `attachment` entries, NOT role:user messages — Claude Code fires no
      // UserPromptSubmit for them. The prompt-kind walker already captures
      // them as steering batches via the manifest `queued_command` shape
      // (textAt: attachment.prompt). This parser drives response attribution
      // (getAllTurns → populateBatchResponses); without recognizing the same
      // entries it builds no turn for the queued prompt, so the assistant text
      // that follows globs onto the PRECEDING turn (e.g. a task-notification)
      // and the steering batch is left with a NULL response_summary. Open a
      // new turn here, keyed on the same `attachment.prompt` text the walker
      // uses, so prefix-matching in populateBatchResponses lines the response
      // up with the steering batch.
      if (entry.type === 'attachment') {
        const attachment = entry.attachment as { type?: string; prompt?: string } | undefined;
        if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string' && attachment.prompt.trim()) {
          if (current) turns.push(current);
          current = { prompt: attachment.prompt.trim().slice(0, PROMPT_PREVIEW_CHARS), toolCount: 0, timestamp };
        }
        // Other attachment kinds (image side-logs, etc.) carry no turn text.
        continue;
      }

      if (role === 'user') {
        // Skip meta messages (skill injections, deprecation notices, etc.) — they are
        // not real user prompts and should not appear as turns or influence the title.
        if (entry.isMeta === true) continue;

        const msg = entry.message as { content?: string | Array<{ type: string; text?: string; source?: { type?: string; data?: string; media_type?: string } }> } | undefined;

        // Claude Code v2.1.x emits real user prompts as `message.content: string`
        // and tool_result entries as `message.content: [{type:'tool_result', …}]`.
        // Pre-v2.1, both used arrays; the prompt-kind walker handles both forms
        // via extractText. Mirror that here so transcript mining sees real user
        // turns again — without it every user entry's blocks are empty and the
        // parser returns zero turns, breaking response_summary populateBatchResponses.
        let rawPrompt = '';
        let images: TranscriptImage[] = [];

        if (typeof msg?.content === 'string') {
          rawPrompt = msg.content;
        } else if (Array.isArray(msg?.content)) {
          const blocks = msg!.content;
          rawPrompt = blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('\n');
          images = blocks
            .filter((b) => b.type === 'image' && b.source?.type === 'base64' && b.source.data)
            .map((b) => ({ data: b.source!.data!, mediaType: b.source!.media_type ?? 'image/png' }));
        }

        if (!rawPrompt.trim()) continue;

        if (current) turns.push(current);

        const promptText = (this.opts.stripImageTextRefs ? rawPrompt.replace(IMAGE_TEXT_REF_PATTERN, '') : rawPrompt)
          .trim()
          .slice(0, PROMPT_PREVIEW_CHARS);

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
