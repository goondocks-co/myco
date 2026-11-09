import type { DocRecord } from './document.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { filesNamedByToolInput, mycoToolFields, MAX_FILE_PATH_CHARS, MAX_FILES_AFFECTED } from '@goondocks/myco-shared/member-protocol';
import { getAtPath } from '@goondocks/myco-shared/dot-path';

export const ROLLUP_TOOLS = 8;
const ERROR_EXCERPT_CHARS = 240;

export interface ToolRollup {
  tools: { name: string; count: number }[];
  myco: { name: string; count: number; failed: number }[];
  firstError: string | null;
  filesEdited: number;
  lastRecordAt: number | null;
}

/** Scalar totals and the current transaction’s keyed contribution deltas. */
export interface ToolState {
  calls: Record<string, { known: boolean; name: string; tool: string | null; op: string | null; files: string[]; named: string[] }>;
  tools: [string, number][];
  myco: [string, number, number][];
  files: [string, number][];
  named: [string, number][];
  errors: [string, number, string][];
  removedErrors: string[];
  total: number;
  failed: number;
  mycoCalls: number;
  last: number | null;
}

export const emptyToolState = (): ToolState => ({ calls: {}, removedErrors: [], tools: [], myco: [], files: [], named: [], errors: [], total: 0, failed: 0, mycoCalls: 0, last: null });

export function recordMycoFields(record: DocRecord) {
  let input: unknown = record.input;
  if (typeof input === 'string') {
    try { input = JSON.parse(input) as unknown; } catch { input = null; }
  }
  const fields = mycoToolFields(String(record.tool_name ?? ''), input);
  return { tool: typeof record.myco_tool === 'string' ? record.myco_tool : fields.mycoTool ?? null,
    op: typeof record.myco_op === 'string' ? record.myco_op : fields.mycoOp ?? null };
}

/** Named paths include patch headers; editing authority comes from the harness's capture declaration. */
export function toolFiles(record: DocRecord, harness: string | null = null): string[] {
  harness = typeof record.harness === 'string' ? record.harness : harness;
  const paths = Array.isArray(record.files_affected) ? record.files_affected.filter((p): p is string => typeof p === 'string') : [];
  let input: unknown = record.input;
  if (typeof input === 'string' && !input.startsWith('*** Begin Patch')) {
    try { input = JSON.parse(input) as unknown; } catch { return [...new Set(paths)]; }
  }
  for (const tool of CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === harness)?.fileTools ?? []) {
    if (tool.tool !== record.tool_name) continue;
    const path = getAtPath(input, tool.pathField);
    if (tool.extract === 'patch') paths.push(...filesNamedByToolInput(path) ?? []);
    else if (typeof path === 'string' && path.length > 0 && path.length <= MAX_FILE_PATH_CHARS) paths.push(path);
  }
  return [...new Set([...paths, ...filesNamedByToolInput(input) ?? []])].slice(0, MAX_FILES_AFFECTED);
}

export function editedFiles(record: DocRecord, harness: string | null): string[] {
  harness = typeof record.harness === 'string' ? record.harness : harness;
  const declared = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === harness)?.fileTools ?? [];
  return declared.some(tool => tool.tool === record.tool_name && tool.mutates) ? toolFiles(record, harness) : [];
}

/** Applies a placed record's contribution, removing the held version before a merged outcome. */
export function adjustToolState(state: ToolState, record: DocRecord, harness: string | null, sign: 1 | -1): void {
  if (sign === 1) state.last = Math.max(state.last ?? 0, record.created_at);
  if (record.k !== 'tool') return;
  const held = Object.hasOwn(state.calls, record.id) ? state.calls[record.id] : undefined;
  const myco = recordMycoFields(record);
  const call = held !== undefined && (sign === -1 || held.known) ? held : {
    known: record.call_source != null, name: String(record.tool_name ?? 'unknown'), tool: myco.tool, op: myco.op,
    files: editedFiles(record, harness), named: toolFiles(record, harness),
  };
  if (record.bodies?.input !== undefined) Object.defineProperty(state.calls, record.id, { value: call, enumerable: true, writable: true, configurable: true });
  else if (sign === 1) delete state.calls[record.id];
  const counts = (entries: [string, number][], name: string) => {
    const map = new Map(entries);
    const count = (map.get(name) ?? 0) + sign;
    if (count === 0) map.delete(name); else map.set(name, count);
    return [...map];
  };
  const failed = record.success === 0 ? 1 : 0;
  state.total += sign;
  state.failed += sign * failed;
  state.tools = counts(state.tools, call.name);
  for (const path of call.named) state.named = counts(state.named, path);
  for (const path of call.files) state.files = counts(state.files, path);
  if (call.tool !== null) {
    const name = call.tool + (call.op === null ? '' : `:${call.op}`);
    const map = new Map(state.myco.map(([key, count, errors]) => [key, [count, errors]] as const));
    const held = map.get(name) ?? [0, 0];
    const count = held[0]! + sign;
    const failures = held[1]! + sign * failed;
    if (count === 0 && failures === 0) map.delete(name); else map.set(name, [count, failures]);
    state.myco = [...map].map(([key, [calls, errors]]) => [key, calls!, errors!]);
    state.mycoCalls += sign;
  }
  state.removedErrors.push(record.id);
  state.errors = state.errors.filter(([id]) => id !== record.id);
  if (failed && sign === 1) state.errors.push([record.id, record.created_at, String(record.error_message ?? record.result_reason ?? 'Tool call did not succeed').slice(0, ERROR_EXCERPT_CHARS)]);
}

/** Only declared paths and missing Myco operations can gain information from a spilled input. */
export function needsToolInput(record: DocRecord, harness: string | null): boolean {
  if (record.k !== 'tool' || Object.hasOwn(record, 'harness')) return false;
  const myco = recordMycoFields(record);
  return (myco.tool !== null && myco.op === null)
    || (CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === harness)?.fileTools ?? []).some(tool => tool.tool === record.tool_name);
}

/** The persisted accumulator contains scalars; keyed rows retain distinct contributions. */
export function scalarToolState(state: ToolState): string {
  return JSON.stringify({ total: state.total, failed: state.failed, mycoCalls: state.mycoCalls, last: state.last });
}
export function parseToolState(text: string): ToolState {
  return { ...emptyToolState(), ...JSON.parse(text) as Pick<ToolState, 'total' | 'failed' | 'mycoCalls' | 'last'> };
}
