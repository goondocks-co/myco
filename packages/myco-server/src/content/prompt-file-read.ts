import { promptReferencesFile } from '@goondocks/myco-shared/prompt-file-references';
import type { DocRecord } from './document.js';

/** A prompt longer than this names its own work: no file it points at stands for it. */
const SHORT_PROMPT_CHARS = 400;
const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'file_read', 'read_text_file']);
const PATH_FIELDS = ['file_path', 'path', 'filePath', 'target_file'] as const;
const pathBoundary = (char: string | undefined) => char === undefined || /[\s`"'()[\]{},;!?]/.test(char);

/** A read-type tool contributes an excerpt for a bounded prompt path matching its full path or a path-segment suffix. */
function fileRead(record: DocRecord, prompt: string): boolean {
  if (record.k !== 'tool' || record.success === 0 || !READ_TOOLS.has(String(record.tool_name).split(/[./]/).at(-1)!.toLowerCase())) return false;
  let input: unknown = record.input;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return false; } }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  return PATH_FIELDS.some(field => {
    const path = (input as Record<string, unknown>)[field];
    if (typeof path !== 'string' || path.length === 0) return false;
    if (promptReferencesFile(prompt, path)) return true;
    const suffixes = [path, ...Array.from(path.matchAll(/[\\/]/g), match => path.slice(match.index + 1)).filter(Boolean)];
    return suffixes.some(named => {
      for (let at = prompt.indexOf(named); at >= 0; at = prompt.indexOf(named, at + 1)) {
        if (pathBoundary(prompt[at - 1]) && pathBoundary(prompt[at + named.length])) return true;
      }
      return false;
    });
  });
}

/**
 * The stored opening text of the file a short prompt points at, from the turn's own successful read of that path; null
 * when the prompt is long, names no file, or the turn read none it names.
 */
export function openingRead(records: readonly DocRecord[], prompt: string): string | null {
  if (prompt.length > SHORT_PROMPT_CHARS) return null;
  const output = records.find(record => fileRead(record, prompt))?.output_preview;
  return typeof output === 'string' && output.trim() !== '' ? output : null;
}
