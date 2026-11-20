import { CURATION_BODY_OVER_LIMIT } from '@goondocks/myco-shared/call-words';
import { admitAgentLine, agentLineNotation } from './agent-line.js';
import { AGENT_LINE_MAX_CHARS } from './injection.js';
import { CURATION_BODY_CHARS, CURATION_NEW_NOTES, CURATION_REASON_CHARS, CURATION_TYPES, type CurationAnswer, type CurationNote } from './spore-curation-contract.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const size = (value: unknown): string => typeof value === 'string' ? value.trim().length === 0 ? `0 non-whitespace (${value.length} raw)` : String(value.length) : 'missing or not text';
const shown = (value: unknown): string => JSON.stringify(value)?.replaceAll(':', '\\u003a') ?? 'missing';
const keys = (value: Record<string, unknown>, allowed: string[]): string | null => Object.keys(value).find(key => !allowed.includes(key)) ?? null;

export function checkCurationAnswer(input: Record<string, unknown>, memberIds: readonly string[]): CurationAnswer | string {
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
    if (typeof raw.content === 'string' && raw.content.length > CURATION_BODY_CHARS) {
      const over = raw.content.length - CURATION_BODY_CHARS;
      return `notes[${index}].content ${CURATION_BODY_OVER_LIMIT}: it has ${raw.content.length} characters, ${over} more than the ${CURATION_BODY_CHARS} allowed, counting spaces and line breaks; shorten that body by at least ${over} character${over === 1 ? '' : 's'}`;
    }
    if (!text(raw.content, CURATION_BODY_CHARS)) return `notes[${index}].content has ${size(raw.content)} characters; expected 1–${CURATION_BODY_CHARS}`;
    const admitted = admitAgentLine(raw.agent_line);
    if ('error' in admitted) return `notes[${index}].${admitted.error}; limit ${AGENT_LINE_MAX_CHARS}`;
    const line = admitted.line;
    const notation = agentLineNotation(line);
    if (notation !== null) return `notes[${index}].agent_line contains code notation ${shown(notation)}; use plain situation and guidance, with no path, flag or symbol`;
    notes.push({ sources: raw.sources as string[], observation_type: raw.observation_type, agent_line: line, content: raw.content });
  }
  for (const id of input.keep) { const bad = use(id, 'keep'); if (bad !== null) return bad; }
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
