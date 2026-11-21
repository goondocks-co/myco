/** A settled turn's lead facts, from records its settle already holds: what its prompt's file read opens with, and its notice. */
import type { DocRecord } from './document.js';
import { openingRead } from './prompt-file-read.js';
import { clipLine, isPromptNotice, type LeadFacts } from '../read/turn-lead.js';

const NUMBERED = /^\s*\d+(?:\t|→)/;
const FENCE = /^(?:`{3,}|~{3,})/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * The first heading or prose line of a file's opening text: front matter, fences and the code they hold, rules and
 * comment lines are passed over, and a numbered listing's line numbers are removed when every line carries one.
 */
function openingLine(text: string): string | null {
  let lines = text.split(/\r?\n/);
  if (lines.filter(line => line.trim() !== '').every(line => NUMBERED.test(line))) lines = lines.map(line => line.replace(NUMBERED, ''));
  let skipping: 'front' | 'fence' | null = null;
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const opening = first;
    first = false;
    if (skipping === 'front') { if (line === '---') skipping = null; continue; }
    if (skipping === 'fence') { if (FENCE.test(line)) skipping = null; continue; }
    if (opening && line === '---') { skipping = 'front'; continue; }
    if (FENCE.test(line)) { skipping = 'fence'; continue; }
    if (RULE.test(line) || /^<!--.*-->$/.test(line)) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line)?.[1];
    const shown = (heading ?? line).replace(/\s+/g, ' ').trim();
    if (shown !== '') return clipLine(shown);
  }
  return null;
}

/**
 * What a settle writes of a turn's lead facts: what its prompt's file read opens with, and its notice. With every page of
 * the turn held they are set, and finding none clears them; with part of a wide turn held only the facts found are merged
 * over those stored, since a read on a page not held is no evidence of none.
 */
export function leadFactsChange(prompt: DocRecord, records: readonly DocRecord[], complete: boolean): { lead_facts: string | null } | { lead_merge: string } | Record<string, never> {
  const read = typeof prompt.text === 'string' ? openingRead(records, prompt.text) : null;
  const line = read === null ? null : openingLine(read);
  const notice = isPromptNotice(prompt.notice) ? prompt.notice : null;
  const facts: LeadFacts | null = line === null && notice === null ? null : { ...(line === null ? {} : { read: line }), ...(notice === null ? {} : { notice }) };
  if (complete) return { lead_facts: facts === null ? null : JSON.stringify(facts) };
  return facts === null ? {} : { lead_merge: JSON.stringify(facts) };
}
