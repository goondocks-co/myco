import { CURATION_BODY_OVER_LIMIT } from '@goondocks/myco-shared/call-words';
import { admitAgentLine, agentLineNotation, agentLineTaskState, normalizeAgentLine } from './agent-line.js';
import { AGENT_LINE_MAX_CHARS, AGENT_LINE_TARGET_WORDS } from './injection.js';
import { CURATION_BODY_CHARS, CURATION_NEW_NOTES, CURATION_REASON_CHARS, CURATION_TYPES, type CurationAnswer, type CurationNote } from './spore-curation-contract.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const size = (value: unknown): string => typeof value === 'string' ? value.trim().length === 0 ? `0 non-whitespace (${value.length} raw)` : String(value.length) : 'missing or not text';
const shown = (value: unknown): string => JSON.stringify(value)?.replaceAll(':', '\\u003a') ?? 'missing';
const keys = (value: Record<string, unknown>, allowed: string[]): string | null => Object.keys(value).find(key => !allowed.includes(key)) ?? null;

/** What a member's stored agent_line breaks of the rule every new note meets, in plain words, or null when it meets it. */
export function curationLineCheck(stored: string | null): string | null {
  const line = normalizeAgentLine(stored ?? '');
  if (line.length === 0) return 'The agent_line is missing.';
  if (line.length > AGENT_LINE_MAX_CHARS) return `The agent_line has ${line.length} characters, over the ${AGENT_LINE_MAX_CHARS} allowed.`;
  const notation = agentLineNotation(line);
  return notation === null ? null : `The agent_line carries code notation ${JSON.stringify(notation)}.`;
}

/** The longest body a note written again from this one member may have: the usual limit, or the member's own body plus its old line when that line is marked, so what moves out of the line fits. */
export function curationBodyLimit(content: string, stored: string | null): number {
  return curationLineCheck(stored) === null ? CURATION_BODY_CHARS : Math.max(CURATION_BODY_CHARS, content.length + normalizeAgentLine(stored ?? '').length);
}

/** A group member as the check reads it: its id, what the server found wrong with its agent_line, and the body limit of a note written again from it alone. */
export interface CheckedMember { id: string; lineCheck: string | null; bodyLimit: number }

export function checkCurationAnswer(input: Record<string, unknown>, group: readonly CheckedMember[]): CurationAnswer | string {
  const memberIds = group.map(member => member.id), lineChecks = new Map(group.map(member => [member.id, member.lineCheck])), bodyLimits = new Map(group.map(member => [member.id, member.bodyLimit]));
  const extra = keys(input, ['op', 'project', 'notes', 'keep', 'retire', 'reason']);
  if (extra !== null) return `argument ${shown(extra)} is not declared; omit it`;
  if (input.op !== 'answer') return `op is ${shown(input.op)}; expected answer`;
  if (!Array.isArray(input.notes) || input.notes.length > CURATION_NEW_NOTES)
    return `notes has ${Array.isArray(input.notes) ? input.notes.length : 'missing or non-array'} entries; limit ${CURATION_NEW_NOTES}`;
  if (!Array.isArray(input.keep) || !Array.isArray(input.retire)) return 'keep and retire must both be arrays, including [] when empty';
  if (!text(input.reason, CURATION_REASON_CHARS)) return `reason has ${size(input.reason)} characters; expected 1–${CURATION_REASON_CHARS}`;
  const members = new Set(memberIds), disposition = new Map<string, string>();
  const use = (id: unknown, kind: string, split = false): string | null => {
    if (typeof id !== 'string' || !members.has(id)) return `id ${shown(id)} is not an exact assigned member id; retain its type prefix`;
    const prior = disposition.get(id);
    if (prior !== undefined && !(split && prior === 'sources')) return `member ${shown(id)} occurs in both ${prior} and ${kind}; use one disposition`;
    disposition.set(id, kind); return null;
  };
  const notes: CurationNote[] = [];
  for (const [index, raw] of input.notes.entries()) {
    if (!object(raw)) return `notes[${index}] is not an object`;
    const extra = keys(raw, ['sources', 'observation_type', 'agent_line', 'content']);
    if (extra !== null) return `notes[${index}].${shown(extra)} is not declared; omit it (the server derives observed)`;
    if (!Array.isArray(raw.sources) || raw.sources.length === 0 || raw.sources.length > members.size)
      return `notes[${index}].sources has ${Array.isArray(raw.sources) ? raw.sources.length : 'missing or non-array'} entries; expected 1–${members.size}`;
    if (new Set(raw.sources).size !== raw.sources.length) return `notes[${index}].sources repeats an id; each note lists distinct sources`;
    for (const id of raw.sources) { const bad = use(id, 'sources', true); if (bad !== null) return bad; }
    if (typeof raw.observation_type !== 'string' || !(CURATION_TYPES as readonly string[]).includes(raw.observation_type))
      return `notes[${index}].observation_type is ${shown(raw.observation_type)}; expected ${CURATION_TYPES.join('|')}`;
    const limit = raw.sources.length === 1 ? bodyLimits.get(raw.sources[0] as string) ?? CURATION_BODY_CHARS : CURATION_BODY_CHARS;
    if (typeof raw.content === 'string' && raw.content.length > limit) {
      const over = raw.content.length - limit;
      return `notes[${index}].content ${CURATION_BODY_OVER_LIMIT}: it has ${raw.content.length} characters, ${over} more than the ${limit} allowed, counting spaces and line breaks; shorten that body by at least ${over} character${over === 1 ? '' : 's'}`;
    }
    if (!text(raw.content, limit)) return `notes[${index}].content has ${size(raw.content)} characters; expected 1–${limit}`;
    const admitted = admitAgentLine(raw.agent_line);
    const length = typeof raw.agent_line === 'string' ? normalizeAgentLine(raw.agent_line).length : 0;
    if (length > AGENT_LINE_MAX_CHARS) return `notes[${index}].agent_line has ${length} characters after whitespace normalization, ${length - AGENT_LINE_MAX_CHARS} more than the ${AGENT_LINE_MAX_CHARS} allowed; shorten that line by at least ${length - AGENT_LINE_MAX_CHARS} characters, to about ${AGENT_LINE_TARGET_WORDS} short words, moving detail into the content`;
    if ('error' in admitted) return `notes[${index}].${admitted.error}`;
    const line = admitted.line;
    const notation = agentLineNotation(line);
    if (notation !== null) return `notes[${index}].agent_line contains code notation ${shown(notation)}; use plain situation and guidance, with no path, flag or symbol`;
    const taskState = agentLineTaskState(line);
    if (taskState !== null) return `notes[${index}].agent_line states the state of a task, ${shown(taskState)}; write what stays true after the task ends, with any branch or pull request only in content as where it was observed`;
    notes.push({ sources: raw.sources as string[], observation_type: raw.observation_type, agent_line: line, content: raw.content });
  }
  for (const id of input.keep) {
    const bad = use(id, 'keep'); if (bad !== null) return bad;
    const found = lineChecks.get(id as string);
    if (found != null) return `member ${shown(id)} cannot be kept as it is: ${found} Remove it from keep and write it again as a new note with sources [${shown(id)}], an agent_line that meets the rule and a body that keeps every specific of the old note, or include it in a merge or split`;
  }
  const retire: CurationAnswer['retire'] = [];
  for (const [index, raw] of input.retire.entries()) {
    if (!object(raw)) return `retire[${index}] is not an object`;
    const extra = keys(raw, ['id', 'reason', 'made_unnecessary_by']);
    if (extra !== null) return `retire[${index}].${shown(extra)} is not declared; omit it`;
    const bad = use(raw.id, 'retire'); if (bad !== null) return bad;
    if (!text(raw.reason, CURATION_REASON_CHARS)) return `retire[${index}].reason has ${size(raw.reason)} characters; expected 1–${CURATION_REASON_CHARS}`;
    const target = raw.made_unnecessary_by;
    const newIndex = typeof target === 'string' && /^new:(0|[1-9][0-9]*)$/.test(target) ? Number(target.slice(4)) : -1;
    if (!(typeof target === 'string' && (input.keep.includes(target) || (newIndex >= 0 && newIndex < notes.length))))
      return `retire[${index}].made_unnecessary_by is ${shown(target)}; expected a kept member id${notes.length === 0 ? ' (this answer writes 0 new notes)' : ` or new:0 through new:${notes.length - 1}`}`;
    retire.push({ id: raw.id as string, reason: raw.reason, made_unnecessary_by: target as string });
  }
  const missing = memberIds.filter(id => !disposition.has(id));
  if (missing.length > 0) return `answer omits ${missing.length} members: ${shown(missing)}; every member needs a disposition`;
  return { notes, keep: input.keep as string[], retire, reason: input.reason };
}
