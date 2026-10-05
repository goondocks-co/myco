import { utf8 } from '../../hash.js';
import { MAX_PAYLOAD_BYTES, parseEnvelope } from '../envelope.js';
import { kindSpec, parsePayload, type Payload } from '../kinds.js';
import type { DerivedEvent, ParserState } from './index.js';

const OMITTED_TOOL_INPUT = { omitted: 'transcript tool input exceeds ingest bounds' } as const;
const ADMISSION_EVENT_ID = '00000000-0000-4000-8000-000000000000';

function envelopeAdmits(payload: Payload, event: DerivedEvent): boolean {
  return parseEnvelope({
    eventId: ADMISSION_EVENT_ID,
    sessionId: ADMISSION_EVENT_ID,
    kind: event.kind,
    createdAt: event.createdAt,
    channel: 'http',
    producer: { adapter: 'server', version: '1' },
    payload,
  }, event.createdAt).ok;
}

function payloadBytes(payload: Payload): number {
  const json = JSON.stringify(payload);
  return json.length > MAX_PAYLOAD_BYTES ? json.length : utf8(json).byteLength;
}

function cutAtCodePoint(text: string, length: number): number {
  if (length > 0 && length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]) && /[\uDC00-\uDFFF]/.test(text[length])) return length - 1;
  return length;
}

function shortText(text: string, maxChars: number, fits: (candidate: string) => boolean): string {
  if (text.length <= maxChars && fits(text)) return text;
  let low = 0;
  let high = Math.min(text.length, maxChars);
  const marked = (length: number): string => {
    const cut = cutAtCodePoint(text, length);
    return `${text.slice(0, cut)}\n\n[${text.length - cut} characters not kept]`;
  };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = marked(middle);
    if (candidate.length <= maxChars && fits(candidate)) low = middle;
    else high = middle - 1;
  }
  return marked(low);
}

/** Bound every transcript-derived payload at the common parser exit, using the ingest catalogue and encoded envelope limit. */
export function boundDerivedEvent(event: DerivedEvent): DerivedEvent {
  const spec = kindSpec(event.kind);
  if (spec === null) throw new Error(`unknown transcript-derived kind ${event.kind}`);
  const payload: Payload = { ...event.payload };
  if ((event.kind === 'tool.use' || event.kind === 'tool.failure') && payload.input === undefined && payload.blob === undefined) payload.input = {};

  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    const value = payload[field];
    if (fieldSpec.bound.type !== 'string' || typeof value !== 'string') continue;
    payload[field] = shortText(value, fieldSpec.bound.max, () => true);
  }

  if (payload.input !== undefined && !envelopeAdmits({ input: payload.input }, event)) {
    payload.input = OMITTED_TOOL_INPUT;
  }

  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    const fields = Object.entries(spec.fields)
      .filter(([field, fieldSpec]) => fieldSpec.bound.type === 'string' && typeof payload[field] === 'string')
      .sort(([a], [b]) => (payload[b] as string).length - (payload[a] as string).length);
    for (const [field, fieldSpec] of fields) {
      if (payloadBytes(payload) <= MAX_PAYLOAD_BYTES) break;
      if (fieldSpec.bound.type !== 'string') continue;
      const original = payload[field] as string;
      payload[field] = shortText(original, fieldSpec.bound.max, (candidate) => payloadBytes({ ...payload, [field]: candidate }) <= MAX_PAYLOAD_BYTES);
    }
  }

  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES && payload.input !== undefined) payload.input = OMITTED_TOOL_INPUT;

  const admitted = parsePayload(spec, payload, event.createdAt);
  if (!admitted.ok || !envelopeAdmits(payload, event)) {
    throw new Error(`transcript parser emitted inadmissible ${event.kind}: ${admitted.ok ? 'payload bytes' : admitted.reason}`);
  }
  return { ...event, payload };
}

export function boundDerivedEvents(events: readonly DerivedEvent[]): DerivedEvent[] {
  return events.map(boundDerivedEvent);
}

/** Pending tool calls use the same payload budget before their continuation is persisted. */
export function boundPendingInputs(state: ParserState | undefined): void {
  for (const call of Object.values(state?.pending ?? {})) {
    const bounded = boundDerivedEvent({
      kind: 'tool.use',
      payload: { toolCallId: call.toolCallId, promptId: call.promptId, toolName: call.toolName, input: call.input, success: true },
      createdAt: call.createdAt,
      offset: call.offset,
    });
    call.input = bounded.payload.input;
  }
}
