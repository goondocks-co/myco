import { utf8 } from '../hash.js';

export const TOOL_INPUT_PREVIEW_BYTES = 2048;

/** A UTF-8 prefix within the display bound, ending at a complete code point. */
export function toolInputPreview(text: string): { preview: string; bytes: number; previewBytes: number; truncated: boolean } {
  const encoded = utf8(text);
  if (encoded.byteLength <= TOOL_INPUT_PREVIEW_BYTES) return { preview: text, bytes: encoded.byteLength, previewBytes: encoded.byteLength, truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = TOOL_INPUT_PREVIEW_BYTES; end > TOOL_INPUT_PREVIEW_BYTES - 4; end--) {
    try {
      return { preview: decoder.decode(encoded.subarray(0, end)), bytes: encoded.byteLength, previewBytes: end, truncated: true };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new Error('UTF-8 input prefix cannot end at a code point');
}
