import { sha256Hex } from './hash.js';

/**
 * Structure-only view of a transcript JSONL file. This is the mechanism
 * behind "default bundles contain none of your prompts or code": each
 * output line is constructed from a fixed field set, so fields added by
 * evolving agent harnesses can never leak into a bundle.
 */
export function skeletonizeTranscript(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    out.push(JSON.stringify(skeletonizeLine(line)));
  }
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

function skeletonizeLine(line: string): Record<string, unknown> {
  const byte_length = Buffer.byteLength(line, 'utf8');
  let evt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'unparseable', byte_length };
    }
    evt = parsed as Record<string, unknown>;
  } catch {
    return { type: 'unparseable', byte_length };
  }

  const message = (evt.message ?? null) as Record<string, unknown> | null;
  const content = message && typeof message === 'object' ? message.content : undefined;
  const text = extractText(content);
  return {
    type: typeof evt.type === 'string' ? evt.type : 'unknown',
    timestamp: typeof evt.timestamp === 'string' ? evt.timestamp : null,
    uuid: typeof evt.uuid === 'string' ? evt.uuid : null,
    parent_uuid: typeof evt.parentUuid === 'string' ? evt.parentUuid : null,
    role: message && typeof message.role === 'string' ? message.role : null,
    content_hash: content === undefined ? null : sha256Hex(JSON.stringify(content)),
    // Cross-layer correlation key: sha256 of the trimmed user-visible text,
    // comparable to user_prompt_sha256 on prompt_batches rows (the stored
    // content_hash columns are canonical-tuple hashes and never match).
    text_sha256: text === null ? null : sha256Hex(text.trim()),
    byte_length,
  };
}

/** User-visible text of a content field: a plain string, or joined text blocks. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: string; text: string } =>
        b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}
