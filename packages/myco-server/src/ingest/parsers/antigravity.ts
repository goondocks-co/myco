import { RecordSourceInvalid } from '@goondocks/myco-shared/record-identity';
import { cleanAntigravityUserPrompt, isAntigravityUserInput } from '@goondocks/myco-shared/antigravity-parser';
import { recordedPromptLabel, lineTime, promptIdentity, recordSource, str, type DerivedEvent, type TranscriptParser } from './index.js';

/** Antigravity's step JSONL. Tool results carry no call key; hooks own tool rows. */
export const antigravityParser: TranscriptParser = {
  agent: 'antigravity',
  fidelity: 'no_tool_results',
  replyAggregation: 'last',
  schemes: ['member-transcript-v1'],
  planTags: [],
  lineTimeField: 'created_at',
  async parse(input) {
    const events: DerivedEvent[] = [];
    let promptId = input.openPromptId;
    for (const { value, offset, undatedAt } of input.lines) {
      const createdAt = lineTime({ timestamp: value.created_at }, input.now, undatedAt);
      if (isAntigravityUserInput(value)) {
        const text = cleanAntigravityUserPrompt(str(value.content) ?? '');
        if (text === '') continue;
        const key = value.step_index;
        if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0) throw new RecordSourceInvalid();
        promptId = await promptIdentity(input, { scheme: 'member-transcript-v1', sessionId: input.sessionId, dedupeKey: String(key), position: offset });
        const label = recordedPromptLabel({ agent: this.agent, input, record: value, text, label: { origin: 'user', kind: 'user_prompt' } });
        events.push({ kind: 'prompt', offset, createdAt, payload: { promptId, text, origin: label.origin, promptKind: label.kind } });
      } else if (value.type === 'PLANNER_RESPONSE' && !(Array.isArray(value.tool_calls) && value.tool_calls.length > 0)) {
        const text = str(value.content);
        if (text?.trim()) events.push({ kind: 'response', offset, createdAt,
          source: recordSource(input, this.agent, { kind: 'response', record: value, block: 0 }), payload: { promptId, text } });
      }
    }
    return events;
  },
};
