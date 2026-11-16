import { cleanAntigravityUserPrompt, isAntigravityUserInput } from '@goondocks/myco-shared/antigravity-parser';
import type { SymbiontAdapter } from './adapter.js';
import { AntigravityJsonlParser } from './parsers/antigravity-jsonl.js';
import { findTranscriptFor } from './transcript-discovery.js';

/** Antigravity hooks carry conversationId and transcriptPath; prompts and replies are read from the transcript. */
const antigravityParser = new AntigravityJsonlParser();

export const antigravityAdapter: SymbiontAdapter = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  pluginRootEnvVar: 'ANTIGRAVITY_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'conversationId',
    transcriptPath: 'transcriptPath',
    toolName: 'toolCall.name',
    toolInput: 'toolCall.args',
    toolError: 'error',
  },

  findTranscript: (conversationId) => findTranscriptFor('antigravity', conversationId),

  parseTurns: (content) => antigravityParser.parseTurns(content),
  promptForHook(records, input) {
    const step = input.raw.stepIdx;
    if (input.kind !== 'tool' || typeof step !== 'number' || !Number.isSafeInteger(step)) return undefined;
    for (const { value: record, offset } of records) {
      const key = record.step_index;
      if (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0 && key < step
        && isAntigravityUserInput(record) && cleanAntigravityUserPrompt(typeof record.content === 'string' ? record.content : '') !== '') {
        return { scheme: 'member-transcript-v1', sessionId: input.sessionId, dedupeKey: String(key), position: offset };
      }
    }
    return undefined;
  },
};
