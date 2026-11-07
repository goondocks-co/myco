import { MAX_SPORE_CONTENT_BYTES } from './spores.js';
export const MAX_SPORE_ID_CHARS = 192;
export const MAX_SESSION_ID_CHARS = 384;
export const MAX_SPORE_TAG_CHARS = 4096;
export const MAX_FILE_PATH_CHARS = 4096;
export const PROVENANCE_REF_MAX = 512;
export const OPTIONAL_TEXT_BOUNDS: Readonly<Record<string, number>> = {
  id: MAX_SPORE_ID_CHARS,
  old_spore_id: MAX_SPORE_ID_CHARS,
  new_spore_id: MAX_SPORE_ID_CHARS,
  event_id: MAX_SPORE_ID_CHARS,
  session_id: MAX_SESSION_ID_CHARS,
  prompt_id: MAX_SPORE_ID_CHARS,
  context: MAX_SPORE_CONTENT_BYTES,
  content_hash: MAX_SPORE_ID_CHARS,
  properties: MAX_SPORE_CONTENT_BYTES,
  reason: MAX_SPORE_CONTENT_BYTES,
};
export const COMMIT_REF_MIN_CHARS = 7;
export const COMMIT_REF_MAX_CHARS = 40;
