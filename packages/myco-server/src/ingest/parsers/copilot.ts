import { RecordSourceAbsent, RecordSourceInvalid } from '@goondocks/myco-shared/record-identity';
/** Copilot CLI's persisted session events: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events */
import {
  callForResult, isBlock, lineTime, optionalRecordSource, parserContinuation, promptIdentity, recordId, recordSource, str,
  TOOL_OUTPUT_PREVIEW_CHARS, type DerivedEvent, type TranscriptParser,
} from './index.js';

export const copilotParser: TranscriptParser = {
  agent: 'copilot',
  fidelity: 'full',
  schemes: ['member-transcript-v1'],
  planTags: [],
  async parse(input) {
    const events: DerivedEvent[] = [];
    const continuation = parserContinuation(input);
    const pending = continuation.pending;
    const promptFor = (key: string, position: number) => promptIdentity(input, {
      scheme: 'member-transcript-v1', sessionId: input.sessionId, dedupeKey: key, position,
    });
    const retainCall = async (call: Record<string, unknown>, record: Record<string, unknown>, at: { offset: number; createdAt: number; promptId?: string }) => {
      const source = optionalRecordSource(input, this.agent, { kind: 'tool-call', record, call, role: 'call' });
      const name = str(call.name);
      if (source === undefined || !('key' in source) || name === undefined) return;
      const prior = pending.get(source.key);
      if (prior !== undefined) {
        if (prior.promptId !== undefined && at.promptId !== undefined && prior.promptId !== at.promptId) throw new RecordSourceInvalid();
        prior.promptId ??= at.promptId;
        return;
      }
      pending.set(source.key, { toolCallId: await recordId(input, this.agent, { kind: 'tool-call', source, offset: at.offset }),
        toolName: name.slice(0, 64), input: call.arguments ?? {}, ...at });
    };
    for (const { value, offset, undatedAt } of input.lines) {
      if (!isBlock(value.data)) continue;
      const data = value.data;
      const createdAt = lineTime(value, input.now, undatedAt);
      if (value.type === 'user.message') {
        if (data.source !== undefined || !str(data.content)?.trim()) continue;
        const key = str(data.messageId);
        if (key === undefined || key === '') throw new RecordSourceAbsent();
        const promptId = await promptFor(key, offset);
        events.push({ kind: 'prompt', offset, createdAt, payload: { promptId, text: data.content, origin: 'user', promptKind: 'user_prompt' } });
      } else if (value.type === 'assistant.message') {
        const origin = str(data.originatingMessageId);
        const promptId = origin ? await promptFor(origin, offset) : undefined;
        const text = str(data.content);
        if (text?.trim()) events.push({ kind: 'response', offset, createdAt,
          source: recordSource(input, this.agent, { kind: 'response', record: value, block: 0 }), payload: { promptId, text } });
        for (const call of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          if (!isBlock(call)) continue;
          await retainCall(call, value, { promptId, offset, createdAt });
        }
      } else if (value.type === 'tool.execution_start') {
        await retainCall({ toolCallId: data.toolCallId, name: data.toolName, arguments: data.arguments }, value, { offset, createdAt });
      } else if (value.type === 'tool.execution_complete') {
        const source = recordSource(input, this.agent, { kind: 'tool-call', record: value, result: data, role: 'result' });
        const call = await callForResult(input, this.agent, source, pending, { offset, createdAt });
        const failed = data.success === false;
        const result = isBlock(data.result) ? str(data.result.content) : undefined;
        const error = isBlock(data.error) ? str(data.error.message) : str(data.error);
        const output = (result ?? error)?.slice(0, input.view ? undefined : TOOL_OUTPUT_PREVIEW_CHARS);
        events.push({ kind: failed ? 'tool.failure' : 'tool.use', source, offset, createdAt,
          payload: { toolCallId: call.toolCallId, promptId: call.promptId, toolName: call.toolName, input: call.input, output, success: !failed,
            ...(failed ? { resultReason: 'reported', errorMessage: error ?? 'tool call failed' } : {}) } });
      }
    }
    continuation.save(continuation.position);
    return events;
  },
};
