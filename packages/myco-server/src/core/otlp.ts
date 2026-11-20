import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';
import {
  TELEMETRY_ATTRIBUTE_LIMIT,
  TELEMETRY_BATCH_BYTES,
  TELEMETRY_NAME_BYTES,
  TELEMETRY_SPANS_PER_REQUEST,
  TELEMETRY_TEXT_BYTES,
  TELEMETRY_EARLIEST_MS,
  TELEMETRY_FUTURE_MS,
} from './telemetry-policy.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ObjectValue) : null;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: unknown, limit = TELEMETRY_TEXT_BYTES): value is string =>
  typeof value === 'string' && bytes(value) <= limit;
const STRINGS = new Set([
  'gen_ai.conversation.id',
  'gen_ai.agent.name',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'vcs.repository.url.full',
  'vcs.ref.head.name',
]);
const TOKENS = new Set([
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_write.input_tokens',
  'gen_ai.usage.reasoning.output_tokens',
]);
const RESOURCE = new Set(['service.name', 'service.version']);

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  serviceName: string | null;
  serviceVersion: string | null;
  startNs: string;
  endNs: string;
  startMs: number;
  endMs: number;
  conversationId: string | null;
  agentName: string | null;
  operation: string | null;
  attributes: Record<string, string | number>;
  status: number;
}
export interface ParsedTraces {
  spans: TelemetrySpan[];
  rejected: number;
  reasons: string[];
}

/** Unknown AnyValues are checked for size, then discarded along with events, links and status messages. */
function boundedValue(raw: unknown, depth = 0): boolean {
  const value = object(raw);
  if (value === null || depth > 4 || Object.keys(value).length > 1) return false;
  if (Object.keys(value).length === 0) return true;
  if ('stringValue' in value) return text(value.stringValue);
  if ('bytesValue' in value) return text(value.bytesValue);
  if ('boolValue' in value) return typeof value.boolValue === 'boolean';
  if ('intValue' in value)
    return (
      (typeof value.intValue === 'string' && /^-?\d{1,20}$/.test(value.intValue)) ||
      Number.isSafeInteger(value.intValue)
    );
  if ('doubleValue' in value)
    return typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue);
  const arrayValue = object(value.arrayValue);
  if ('arrayValue' in value && arrayValue === null) return false;
  const array = arrayValue?.values ?? (arrayValue === null ? undefined : []);
  if (Array.isArray(array))
    return array.length <= TELEMETRY_ATTRIBUTE_LIMIT && array.every((item) => boundedValue(item, depth + 1));
  const listValue = object(value.kvlistValue);
  if ('kvlistValue' in value && listValue === null) return false;
  const list = listValue?.values ?? (listValue === null ? undefined : []);
  return (
    Array.isArray(list) &&
    list.length <= TELEMETRY_ATTRIBUTE_LIMIT &&
    list.every((item) => {
      const pair = object(item);
      return pair !== null && text(pair.key, TELEMETRY_NAME_BYTES) && boundedValue(pair.value, depth + 1);
    })
  );
}

function attributes(
  raw: unknown,
  allowed: ReadonlySet<string>,
  tokens: ReadonlySet<string> = new Set(),
): Record<string, string | number> {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length > TELEMETRY_ATTRIBUTE_LIMIT)
    throw new Error(`attributes exceed ${TELEMETRY_ATTRIBUTE_LIMIT} or are malformed`);
  const out: Record<string, string | number> = {};
  const seen = new Set<string>();
  for (const item of raw) {
    const pair = object(item);
    if (
      pair === null ||
      !text(pair.key, TELEMETRY_NAME_BYTES) ||
      !boundedValue(pair.value) ||
      seen.has(pair.key)
    ) {
      throw new Error(`attribute is malformed, duplicated or exceeds ${TELEMETRY_TEXT_BYTES} bytes`);
    }
    seen.add(pair.key);
    const value = object(pair.value)!;
    if (allowed.has(pair.key)) {
      if (!text(value.stringValue)) throw new Error('standard text attribute requires stringValue');
      out[pair.key] = value.stringValue;
    } else if (tokens.has(pair.key)) {
      const count =
        typeof value.intValue === 'string' && /^\d+$/.test(value.intValue)
          ? Number(value.intValue)
          : value.intValue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new Error('token count requires a nonnegative safe intValue');
      out[pair.key] = count;
    }
  }
  return out;
}

const id = (value: unknown, length: number): value is string =>
  typeof value === 'string' &&
  new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value) &&
  /[1-9a-fA-F]/.test(value);
function nano(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || BigInt(value) > 18446744073709551615n)
    throw new Error('time requires uint64 decimal-string nanoseconds');
  return value;
}
const nullable = (attrs: Record<string, string | number>, key: string) =>
  typeof attrs[key] === 'string' && attrs[key] !== '' ? (attrs[key] as string) : null;

/** OTLP/HTTP JSON with hex ids, integer enums and uint64 timestamps as strings or safe integers. */
export function parseTraces(raw: unknown, now = Date.now()): ParsedTraces {
  const root = object(raw);
  if (root === null || (root.resourceSpans !== undefined && !Array.isArray(root.resourceSpans)))
    throw new Error('resourceSpans must be an array');
  const result: ParsedTraces = { spans: [], rejected: 0, reasons: [] };
  let seen = 0;
  let retainedBytes = 2;
  const reject = (reason: string) => {
    result.rejected++;
    if (!result.reasons.includes(reason) && result.reasons.length < 4) result.reasons.push(reason);
  };
  for (const entry of (root.resourceSpans as unknown[]) ?? []) {
    const resource = object(entry);
    if (resource === null || (resource.scopeSpans !== undefined && !Array.isArray(resource.scopeSpans)))
      throw new Error('scopeSpans must be an array');
    let resourceAttrs: Record<string, string | number> = {};
    let resourceError: string | null = null;
    try {
      resourceAttrs = attributes(object(resource.resource)?.attributes, RESOURCE);
    } catch (error) {
      resourceError = (error as Error).message;
    }
    for (const entry of (resource.scopeSpans as unknown[]) ?? []) {
      const scope = object(entry);
      if (scope === null || (scope.spans !== undefined && !Array.isArray(scope.spans)))
        throw new Error('spans must be an array');
      for (const entry of (scope.spans as unknown[]) ?? []) {
        seen++;
        if (seen > TELEMETRY_SPANS_PER_REQUEST) {
          reject(`request exceeds ${TELEMETRY_SPANS_PER_REQUEST} spans`);
          continue;
        }
        if (resourceError !== null) {
          reject(resourceError);
          continue;
        }
        try {
          const span = object(entry);
          if (
            span === null ||
            !id(span.traceId, 32) ||
            !id(span.spanId, 16) ||
            (span.parentSpanId !== undefined && span.parentSpanId !== '' && !id(span.parentSpanId, 16))
          )
            throw new Error('span ids are malformed');
          if (!text(span.name, TELEMETRY_NAME_BYTES) || span.name === '')
            throw new Error(`span name requires 1 to ${TELEMETRY_NAME_BYTES} bytes`);
          const kind = span.kind ?? 0;
          if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 5)
            throw new Error('kind requires an integer enum from 0 to 5');
          const startNs = nano(span.startTimeUnixNano),
            endNs = nano(span.endTimeUnixNano);
          if (BigInt(endNs) < BigInt(startNs)) throw new Error('span ends before it starts');
          if (
            BigInt(startNs) / 1000000n < BigInt(TELEMETRY_EARLIEST_MS) ||
            BigInt(endNs) / 1000000n > BigInt(now + TELEMETRY_FUTURE_MS)
          )
            throw new Error('span times must be from 2020 through one day after receipt');
          const attrs = attributes(span.attributes, STRINGS, TOKENS);
          const conversationId = nullable(attrs, 'gen_ai.conversation.id');
          if (conversationId !== null && conversationId.length > MAX_ID_CHARS)
            throw new Error(`conversation id exceeds ${MAX_ID_CHARS} characters`);
          if (span.status !== undefined && span.status !== null && object(span.status) === null)
            throw new Error('status must be an object');
          const status = object(span.status)?.code ?? 0;
          if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 2)
            throw new Error('status requires an integer enum from 0 to 2');
          const retained: TelemetrySpan = {
            traceId: span.traceId.toLowerCase(),
            spanId: span.spanId.toLowerCase(),
            parentSpanId:
              typeof span.parentSpanId === 'string' && span.parentSpanId !== ''
                ? span.parentSpanId.toLowerCase()
                : null,
            name: span.name,
            kind,
            serviceName: nullable(resourceAttrs, 'service.name'),
            serviceVersion: nullable(resourceAttrs, 'service.version'),
            startNs,
            endNs,
            startMs: Number(BigInt(startNs) / 1000000n),
            endMs: Number(BigInt(endNs) / 1000000n),
            conversationId,
            agentName: nullable(attrs, 'gen_ai.agent.name'),
            operation: nullable(attrs, 'gen_ai.operation.name'),
            attributes: attrs,
            status,
          };
          const size = bytes(JSON.stringify(retained)) + (result.spans.length === 0 ? 0 : 1);
          if (retainedBytes + size > TELEMETRY_BATCH_BYTES)
            throw new Error(`retained batch exceeds ${TELEMETRY_BATCH_BYTES} bytes; split the export`);
          retainedBytes += size;
          result.spans.push(retained);
        } catch (error) {
          reject((error as Error).message);
        }
      }
    }
  }
  return result;
}

/** Discarded signals are counted by records and metric points, never persisted as payloads. */
export function countSignal(raw: unknown, signal: 'logs' | 'metrics'): number {
  const root = object(raw),
    resourceName = signal === 'logs' ? 'resourceLogs' : 'resourceMetrics';
  const scopeName = signal === 'logs' ? 'scopeLogs' : 'scopeMetrics';
  if (root === null || (root[resourceName] !== undefined && !Array.isArray(root[resourceName])))
    throw new Error(`${resourceName} must be an array`);
  let count = 0;
  for (const resource of (root[resourceName] as unknown[]) ?? []) {
    if (object(resource) === null) throw new Error('resource must be an object');
    const scopes = object(resource)![scopeName] ?? [];
    if (!Array.isArray(scopes)) throw new Error(`${scopeName} must be an array`);
    for (const scope of scopes) {
      if (object(scope) === null) throw new Error('scope must be an object');
      const records = object(scope)?.[signal === 'logs' ? 'logRecords' : 'metrics'] ?? [];
      if (!Array.isArray(records) || records.some((record) => object(record) === null))
        throw new Error('records must be an array of objects');
      if (signal === 'logs') count += records.length;
      else
        for (const metric of records) {
          const item = object(metric);
          if (item === null) throw new Error('metric must be an object');
          for (const kind of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']) {
            if (item[kind] !== undefined && object(item[kind]) === null)
              throw new Error('metric data must be an object');
            const points = object(item[kind])?.dataPoints;
            if (
              points !== undefined &&
              (!Array.isArray(points) || points.some((point) => object(point) === null))
            )
              throw new Error('dataPoints must be an array of objects');
            if (Array.isArray(points)) count += points.length;
          }
        }
    }
  }
  return count;
}
