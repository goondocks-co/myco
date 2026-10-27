import { utf8Preview } from '../hash.js';

export const TOOL_INPUT_PREVIEW_BYTES = 2048;

/** A UTF-8 prefix within the display bound, ending at a complete code point. */
export function toolInputPreview(text: string): { preview: string; bytes: number; previewBytes: number; truncated: boolean } {
  return utf8Preview(text,TOOL_INPUT_PREVIEW_BYTES);
}
