import { ownedLines, unfinishedCalls, type DerivedEvent, type TranscriptParser, type ParserState } from './index.js';

/** Immutable assistant records keep the same response identity across every partition of a live transcript. */
export function withParserContinuation(parser: TranscriptParser): TranscriptParser {
  return {
    ...parser,
    async parse(input) {
      const state: ParserState = input.state ?? {};
      const events: DerivedEvent[] = [];
      let openPromptId = input.openPromptId;
      const transcriptMeta = input.transcriptMeta ?? parser.headerContext?.(input.lines);
      for (const line of ownedLines(input.lines, input.sessionId, parser.continuation)) {
        const derived = await parser.parse({ ...input, state, transcriptMeta, lines: [line], openPromptId });
        events.push(...derived);
        for (const event of derived) {
          if (event.kind === 'prompt' && event.opensTurn !== false && typeof event.payload.promptId === 'string') openPromptId = event.payload.promptId;
        }
      }
      if (input.state === undefined) events.push(...unfinishedCalls(Object.values(state.pending ?? {})));
      return events.sort((a, b) => a.offset - b.offset);
    },
  };
}
