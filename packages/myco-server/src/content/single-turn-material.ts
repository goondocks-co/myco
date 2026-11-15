import type { ContentStore } from '../core/adapters.js';
import { titleMaterialSnapshot, titleMaterialTurns } from '../db/documents/titling-material.js';
import { SessionDocument } from './session-pages.js';
import type { DocRecord } from './document.js';

export const SINGLE_TURN_MATERIAL_CHARS = 10_000;
const PROMPT_CHARS = 600;
const REPLY_CHARS = 600;
const FILE_CHARS = 1_000;
const SHORT_PROMPT_CHARS = 400;
const MIDDLE_CHARS = 100;
const FULL_TURN_CHARS = 1_050;

const clip = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, Math.floor(limit * 2 / 3))} […] ${line.slice(-Math.floor(limit / 3) + 5)}`;
};

const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'file_read', 'read_text_file']);
const PATH_FIELDS = ['file_path', 'path', 'filePath', 'target_file'] as const;
const pathBoundary = (char: string | undefined) => char === undefined || /[\s`"'()[\]{},;!?]/.test(char);

/** Only a read-type tool naming the exact path in the person's prompt contributes a file excerpt. */
function fileRead(record: DocRecord, prompt: string): boolean {
  if (record.k !== 'tool' || record.success === 0 || !READ_TOOLS.has(String(record.tool_name).split(/[./]/).at(-1)!.toLowerCase())) return false;
  let input: unknown = record.input;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return false; } }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  return PATH_FIELDS.some(field => {
    const path = (input as Record<string, unknown>)[field];
    if (typeof path !== 'string' || path.length === 0) return false;
    const at = prompt.indexOf(path);
    return at >= 0 && pathBoundary(prompt[at - 1]) && pathBoundary(prompt[at + path.length]);
  });
}

/** Person-authored head and tail turns with closing replies; file context comes only from that turn's stored read. */
export async function singleTurnMaterial(env: ContentStore, project: string, session: string) {
  const held = await titleMaterialSnapshot(env.db, project, session);
  const doc = await SessionDocument.open(env, project, session);
  if (held === null || doc === null || doc.generation !== held.generation || held.userPrompts === 0) throw new Error('title_material_unavailable');
  const turns = await titleMaterialTurns(env.db, project, session, held);
  const lines = [`The session has ${held.userPrompts} prompts from the person.`];
  for (const turn of turns) {
    if (!turn.full) { lines.push(`[Middle prompt] ${clip(turn.preview ?? '', MIDDLE_CHARS)}`); continue; }
    const section: string[] = [];
    const opening = await doc.ownerPages(turn.promptId, 0, 1);
    const records = opening.pages.flatMap(p => p.records);
    const prompt = records.find(r => r.k === 'prompt' && r.id === turn.promptId);
    if (prompt === undefined) throw new Error('title_prompt_unavailable');
    const text = await doc.body(prompt, 'text');
    if (text === null) throw new Error('title_prompt_unavailable');
    section.push(`[Person] ${clip(text, PROMPT_CHARS)}`);
    if (text.length <= SHORT_PROMPT_CHARS) {
      const read = records.find(record => fileRead(record, text));
      const output = read?.output_preview;
      if (typeof output === 'string' && output.trim()) section.push(`[Opening text read for this prompt] ${output.slice(0, FILE_CHARS)}`);
    }
    const last = await doc.lastPage(turn.promptId);
    const closing = last === null || last === 0 ? opening : await doc.ownerPages(turn.promptId, last, 1);
    const reply = closing.pages.flatMap(p => p.records).reverse().find(r => r.k === 'reply' && r.prompt_id === turn.promptId);
    const replyText = reply === undefined ? null : await doc.body(reply, 'text');
    if (replyText !== null) section.push(`[Agent closing reply] ${clip(replyText, REPLY_CHARS)}`);
    lines.push(clip(section.join('\n'), FULL_TURN_CHARS));
  }
  return { text: lines.join('\n').slice(0, SINGLE_TURN_MATERIAL_CHARS), snapshot: held };
}
