import type { ContentStore } from '../core/adapters.js';
import { titleMaterialSnapshot, titleMaterialTurns } from '../db/documents/titling-material.js';
import { SessionDocument } from './session-pages.js';
import { openingRead } from './prompt-file-read.js';
import { speaker } from './turn-lead.js';

import { answerBytes, headThatFits } from '../core/material-pages.js';
import { SINGLE_TURN_MATERIAL_CHARS, SINGLE_TURN_MATERIAL_JSON_BYTES, TITLE_HEAD_TURNS, TITLE_TAIL_TURNS, TITLE_TAIL_ANY_TURNS, TITLE_MIDDLE_TURNS } from '../core/titling-params.js';
const PROMPT_CHARS = 600;
const REPLY_CHARS = 600;
const FILE_CHARS = 1_000;
const MIDDLE_CHARS = 100;
const FULL_TURN_CHARS = 1_050;

const clip = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, Math.floor(limit * 2 / 3))} […] ${line.slice(-Math.floor(limit / 3) + 5)}`;
};
const fitLines = (lines: readonly string[], limit: number): string => {
  if (lines.join('\n').length <= limit) return lines.join('\n');
  const perLine = Math.floor((limit - lines.length + 1) / lines.length);
  return lines.map(line => clip(line, perLine)).join('\n');
};

/** Opening instruction turns and closing turns with closing replies; file context comes only from that turn's stored read. */
export async function singleTurnMaterial(env: ContentStore, project: string, session: string) {
  const held = await titleMaterialSnapshot(env.db, project, session);
  const doc = await SessionDocument.open(env, project, session);
  if (held === null || doc === null || doc.generation !== held.generation || held.instructionPrompts === 0 || held.throughTurnKey == null || held.throughTurnRevision == null) throw new Error('title_material_unavailable');
  const turns = await titleMaterialTurns(env.db, project, session, held);
  const lines = [`Agent: ${held.agent ?? 'unknown'}. Recorded person turns: ${held.personTurns}. The session has ${held.turnCount} turns.`,
    `Material spans the session: first ${TITLE_HEAD_TURNS} instruction turns and last ${TITLE_TAIL_TURNS} turns (the last ${TITLE_TAIL_ANY_TURNS} whoever opened them) with closing replies; up to ${TITLE_MIDDLE_TURNS} evenly spaced middle turn previews. Text is bounded at ${SINGLE_TURN_MATERIAL_CHARS} characters and ${SINGLE_TURN_MATERIAL_JSON_BYTES} JSON bytes.`];
  for (const turn of turns) {
    if (!turn.full) { lines.push(`[Middle turn; ${speaker(turn.origin)}] ${clip(turn.preview ?? '', MIDDLE_CHARS)}`); continue; }
    const section: string[] = [];
    const opening = await doc.ownerPages(turn.promptId, 0, 1);
    const records = opening.pages.flatMap(p => p.records);
    const prompt = records.find(r => r.k === 'prompt' && r.id === turn.promptId);
    if (prompt === undefined) throw new Error('title_prompt_unavailable');
    const text = await doc.body(prompt, 'text');
    if (text === null) throw new Error('title_prompt_unavailable');
    section.push(`[${speaker(turn.origin)}] ${clip(text, PROMPT_CHARS)}`);
    const output = openingRead(records, text);
    if (output !== null) section.push(`[Opening text read for this prompt] ${clip(output, FILE_CHARS)}`);
    const last = await doc.lastPage(turn.promptId);
    const closing = last === null || last === 0 ? opening : await doc.ownerPages(turn.promptId, last, 1);
    const reply = closing.pages.flatMap(p => p.records).reverse().find(r => r.k === 'reply' && r.prompt_id === turn.promptId);
    const replyText = reply === undefined ? null : await doc.body(reply, 'text');
    if (replyText !== null) section.push(`[Agent closing reply] ${clip(replyText, REPLY_CHARS)}`);
    lines.push(...fitLines(section, FULL_TURN_CHARS).split('\n'));
  }
  const text = fitLines(lines, SINGLE_TURN_MATERIAL_CHARS);
  const boundedLines = text.split('\n');
  const fitted = headThatFits(text, SINGLE_TURN_MATERIAL_JSON_BYTES, head => answerBytes(fitLines(boundedLines, head.length)));
  return { text: fitLines(boundedLines, fitted.length), snapshot: held };
}
