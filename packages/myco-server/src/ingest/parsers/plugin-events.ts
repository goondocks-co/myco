/**
 * The parse for a transcript Myco's own plugin wrote.
 *
 * OpenCode and Cline keep no append-only store of their own — one stores a
 * session as a fan-out of JSON files, the other rewrites whole documents in
 * place — so neither can be shipped as a byte delta. Their plugin writes this
 * format instead, one JSON object per line, and the result travels the same
 * road as every other agent's transcript.
 *
 * Myco writes this format, so it is versioned here rather than by a vendor: a
 * line carrying an unknown `v` fails the segment. Skipping such a line would
 * drop a turn with nothing to show for it.
 *
 * A `prompt` line normally carries the id the member's own hook minted, so the
 * row the parse writes is the row the member named. A line written while the
 * hook could not answer carries none, and its id is derived from the byte that
 * produced it — the turn is still the user's work, and dropping it loses a
 * prompt at the moment capture is already degraded.
 */
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { toolResultDeclarationOf, toolResultFailed } from '@goondocks/myco-shared/tool-result';
import { canonicalPromptId } from '@goondocks/myco-shared/prompt-identity';
import { uuidv5 } from '../../hash.js';
import {
  promptIdentity, parserContinuation, recordId, recordSource, legacyRecordId, lineTime, plansInText, str, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type Fidelity, type ParsedLine, type ParserInput, type TranscriptParser,
} from './index.js';

/** The format version this parser reads. The plugin writes it on every line. */
export const PLUGIN_TRANSCRIPT_FORMAT = 1;

/** Raised on a line no version of this parser can read; the driver fails the segment. */
export class UnknownPluginFormat extends Error {}

interface PluginLine {
  v?: unknown;
  type?: unknown;
  sessionId?: unknown;
  promptId?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  output?: unknown;
  failed?: unknown;
  origin?: unknown;
  at?: unknown;
}

/** A tool line's arguments, as the catalogue wants them: a JSON object or nothing. */
function toolInput(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Build the parser for one plugin-written agent.
 *
 * `planTags` is the agent's own, held equal to its manifest by a gate — the
 * member scans exactly these tags, so a list that drifted would derive plans
 * the member never sends or miss the ones it does.
 *
 * `stripEnvelopes` removes a wrapper the harness puts around the model-facing
 * prompt. The plugin strips it too; doing it again here costs nothing and
 * covers anything written before the plugin learned to.
 */
export function pluginEventsParser(options: {
  agent: string;
  fidelity?: Fidelity;
  planTags?: readonly string[];
  stripEnvelopes?: ReadonlyArray<{ open: string; close: string }>;
}): TranscriptParser {
  const { agent, fidelity = 'full', planTags = [], stripEnvelopes = [] } = options;

  const strip = (text: string): string => {
    const trimmed = text.trim();
    for (const { open, close } of stripEnvelopes) {
      if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
        return trimmed.slice(open.length, trimmed.length - close.length).trim();
      }
    }
    return text;
  };

  return {
    agent,
    fidelity,
    schemes: ['stamp-or-offset-v1', 'stamp-or-offset-v2'],
    planTags,
    lineTimeField: 'at',
    async parse(input: ParserInput): Promise<DerivedEvent[]> {
      const events: DerivedEvent[] = [];
      let promptId = input.openPromptId;
      const continuation = parserContinuation(input);
      let planPosition = continuation.position;

      for (const { value, offset, undatedAt } of input.lines as readonly ParsedLine[]) {
        const line = value as PluginLine;
        if (line.v !== undefined && line.v !== PLUGIN_TRANSCRIPT_FORMAT) {
          throw new UnknownPluginFormat(`${agent} transcript line at ${offset} declares format ${String(line.v)}`);
        }
        const createdAt = lineTime({ timestamp: line.at }, input.now, undatedAt);
        const type = str(line.type);

        if (type === 'prompt') {
          const text = typeof line.text === 'string' ? strip(line.text) : '';
          if (text.trim() === '') continue;
          const named = await promptIdentity(input, { scheme: input.scheme === 'stamp-or-offset-v2' ? 'stamp-or-offset-v2' : 'stamp-or-offset-v1', sessionId: input.sessionId, transcriptId: input.transcriptId, stamp: str(line.promptId), offset });
          promptId = named;
          events.push({
            kind: 'prompt',
            payload: {
              promptId: named,
              text,
              origin: str(line.origin) === 'system' ? 'system' : 'user',
              promptKind: 'user_prompt',
            },
            createdAt,
            offset,
          });
          continue;
        }

        if (type === 'response') {
          const text = typeof line.text === 'string' ? line.text : '';
          if (text.trim() === '') continue;
          events.push({
            kind: 'response',
            source: recordSource(input, agent, { kind: 'response', record: value, block: 0 }),
            payload: { promptId: str(line.promptId) ?? promptId, text },
            createdAt,
            offset,
          });
          const plans = await plansInText(text, planTags, input, agent, value, { promptId: str(line.promptId) ?? promptId, offset, createdAt }, planPosition);
          events.push(...plans.events);
          planPosition = plans.next;
          continue;
        }

        if (type === 'tool') {
          const name = str(line.name);
          if (name === undefined) continue;
          const source = recordSource(input, agent, { kind: 'tool-call', record: value, role: 'call' });
          const failed = toolResultFailed({ declaration: toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, agent), record: value, result: line });
          const output = typeof line.output === 'string' ? line.output.slice(0, input.view ? undefined : TOOL_OUTPUT_PREVIEW_CHARS) : undefined;
          events.push({
            kind: failed ? 'tool.failure' : 'tool.use', source,
            legacyId: await legacyRecordId(input, { kind: 'tool-call', source, offset }),
            payload: {
              toolCallId: await recordId(input, agent, { kind: 'tool-call', source, offset }),
              promptId: str(line.promptId) ?? promptId,
              toolName: name.slice(0, 64),
              input: toolInput(line.input) ?? {},
              output,
              success: !failed,
              ...(failed ? { resultReason: 'reported', errorMessage: output ?? 'tool call failed' } : {}),
            },
            createdAt,
            offset,
          });
        }
        // `session` carries the working directory for attribution and opens no
        // row: session facts are the hook's, and a parse that minted them would
        // write a second one.
      }

      continuation.save(planPosition);
      return events;
    },
  };
}
