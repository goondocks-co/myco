import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { getAtPath } from '@goondocks/myco-shared/dot-path';
import { lineTime, optionalRecordSource, recordId, str, type DerivedEvent, type ParsedLine, type ParserInput } from './index.js';

/** Completed calls with their own source ids, including tools invoked inside an orchestration call. */
export async function completedTool(input: ParserInput, agent: string, line: ParsedLine, promptId?: string): Promise<DerivedEvent | null> {
  const { value, offset, undatedAt } = line;
  const shape = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)?.completedTools
    ?.find(rule => Object.entries(rule.match).every(([path, expected]) => getAtPath(value, path) === expected));
  if (shape === undefined) return null;
  const key = str(getAtPath(value, shape.key));
  const name = shape.name ?? (shape.nameAt === undefined ? undefined : str(getAtPath(value, shape.nameAt)));
  if (key === undefined || name === undefined) throw new Error('completed_tool_identity_absent');
  const source = optionalRecordSource(input, agent, { kind: 'tool-call', record: value, role: 'result' });
  if (source === undefined || !('key' in source) || source.key !== key) throw new Error('completed_tool_source_absent');
  const server = shape.serverAt === undefined ? undefined : str(getAtPath(value, shape.serverAt));
  const output = getAtPath(value, shape.outputAt);
  const exit = shape.exitCodeAt === undefined ? undefined : getAtPath(value, shape.exitCodeAt);
  const status = shape.statusAt === undefined ? undefined : getAtPath(value, shape.statusAt);
  const failed = (typeof exit === 'number' && exit !== 0) || (shape.failedStatus !== undefined && status === shape.failedStatus);
  const args = shape.inputAt === undefined
    ? Object.fromEntries(Object.entries(shape.inputFields ?? {}).map(([field, path]) => [field, getAtPath(value, path)]))
    : getAtPath(value, shape.inputAt);
  const text = typeof output === 'string' ? output : JSON.stringify(output) ?? '';
  return {
    kind: failed ? 'tool.failure' : 'tool.use', source, offset, callOffset: offset, outcomeOffset: offset,
    createdAt: lineTime(value, input.now, undatedAt),
    payload: { toolCallId: await recordId(input, agent, { kind: 'tool-call', source, offset }), promptId,
      toolName: server === undefined ? name : `mcp__${server}__${name}`, input: args ?? {}, output: text, success: !failed,
      ...(failed ? { resultReason: 'reported', errorMessage: typeof exit === 'number' ? `Exit code ${exit}` : `Tool status: ${String(status)}` } : {}) },
  };
}
