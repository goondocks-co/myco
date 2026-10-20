/**
 * Claude Code's transcript: one JSON object per line, `type` naming the record.
 *
 * The shapes this reads, and the rule each carries:
 *
 *   user       a prompt when it declares `promptId` and is not `isMeta`; the
 *              same record shape also carries tool RESULTS, which name no
 *              prompt and must never become one. A delegated agent's line
 *              (`isSidechain`) and a teammate's or agent's message envelope
 *              carry the lead's current `promptId` and are not the lead's
 *              prompt: each is its own prompt, keyed on the record's `uuid`,
 *              from an agent.
 *   attachment a queued command — text at `attachment.prompt`, deduped on the
 *              record's own `uuid`.
 *   assistant  `message.content` blocks: `text` is the reply, `tool_use` is a
 *              call awaiting its result, `image` is an attachment.
 *
 * A turn is a prompt and everything until the next prompt. The registry emits
 * joined replies at turn boundaries and retains unresolved tool calls until
 * a result or a declared terminal outcome.
 *
 * Under claude-v2 every record is kept and none is named by another's key
 * (`v2Disposition`). The first record to claim a `promptId` owns it, under the id
 * its hook derives; a later submission reusing the key, another agent's line, a
 * delegated agent's record and a compaction summary are each keyed on their own
 * thread and uuid. Which record owns a key is a stored fact the pass is handed
 * (`ParserInput.owners`), so a reread or a prefix replay decides as the first
 * read did. What a record is comes from the harness's own fields before any text
 * test, and what is not recognized is kept and labelled, never dropped.
 */
import { MAIN_THREAD, type ClaudePromptShape, type PromptClaim } from '@goondocks/myco-shared/prompt-identity';
import { evaluatePromptRules } from '@goondocks/myco-shared/capture-rules';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import type { WirePromptOrigin } from '@goondocks/myco-shared/member-protocol';
import {
  callForResult, recordId, recordSource, optionalRecordSource, claudeRecordIdFor, parserContinuation, blocksOf, isBlock, lineTime, ownedLines, plansInText, promptIdFor, str, textOf, TOOL_OUTPUT_PREVIEW_CHARS,
  type ReplyPart, type DerivedEvent, type ParsedLine, type ParserInput, type TranscriptParser,
} from './index.js';

/** The longest tool name the catalogue admits. */
const TOOL_NAME_CHARS = 64;

/** A user record that names a prompt, rather than one carrying a tool result. */
const namesPrompt = (v: Record<string, unknown>): boolean =>
  v.isMeta !== true
  && str(v.promptId) !== undefined
  && blocksOf((v.message as Record<string, unknown> | undefined)?.content).every((b) => b.type !== 'tool_result');

/** The envelope prefixes of the message shapes the manifest keys on a record's own `uuid` (`capture.prompts.shapes`). */
export const AGENT_MESSAGE_SHAPES: ReadonlyArray<readonly [ClaudePromptShape, string]> = [
  ['agent_message', '<agent-message'], ['teammate_message', '<teammate-message'],
];

/** Which shape a prompt-naming user record is: the person's own prompt, or a line another agent put under its key. */
function promptShape(v: Record<string, unknown>, text: string): ClaudePromptShape {
  if (v.isSidechain === true) return 'sidechain';
  const opening = text.trimStart();
  return AGENT_MESSAGE_SHAPES.find(([, prefix]) => opening.startsWith(prefix))?.[0] ?? 'user_prompt';
}

/** The texts Claude Code writes as a user record when a person interrupts a turn (`claude-code.yaml` `interruptMarker`). */
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

/** Who opened a turn, as a record's `origin.kind`, `turnOrigin` or `promptSource` names it. */
type OpenerClass = 'human' | 'notification' | 'peer' | 'coordinator' | 'scheduled' | 'sdk';
const ORIGIN_KINDS: Readonly<Record<string, OpenerClass>> = { human: 'human', 'task-notification': 'notification', peer: 'peer', coordinator: 'coordinator' };
const TURN_ORIGINS: Readonly<Record<string, OpenerClass>> = { human: 'human', task_notification: 'notification', peer: 'peer', scheduled: 'scheduled', sdk: 'sdk' };
const PROMPT_SOURCES: Readonly<Record<string, OpenerClass>> = { typed: 'human', queued: 'human', suggestion_accepted: 'human', sdk: 'sdk', system: 'notification' };
const CLASS_LABEL: Readonly<Record<OpenerClass, { kind: string; origin: WirePromptOrigin }>> = {
  human: { kind: 'user_prompt', origin: 'user' },
  notification: { kind: 'task_notification', origin: 'system' },
  peer: { kind: 'agent_message', origin: 'agent_dispatch' },
  coordinator: { kind: 'coordinator', origin: 'agent_dispatch' },
  scheduled: { kind: 'scheduled', origin: 'system' },
  sdk: { kind: 'sdk', origin: 'user' },
};

/** A record carries one of the fields Claude Code stamps on the record that opens a turn, whatever shape its value has. */
const hasOpener = (v: Record<string, unknown>): boolean => v.origin !== undefined || v.promptSource !== undefined || v.turnOrigin !== undefined;

/**
 * What a turn-opening record is, from its own fields: `origin.kind` and `turnOrigin` name one class or the record
 * contradicts itself; `promptSource` names it only where neither does. A value outside the declared sets is kept and
 * labelled, never read as a person's.
 */
function openerLabel(v: Record<string, unknown>): { kind: string; origin: WirePromptOrigin } {
  const unrecognized = { kind: 'unrecognized', origin: 'system' as const };
  const kind = v.origin === undefined ? undefined : isBlock(v.origin) ? v.origin.kind ?? null : null;
  const fromOrigin = kind === undefined ? undefined : typeof kind === 'string' ? ORIGIN_KINDS[kind] ?? null : null;
  const fromTurn = v.turnOrigin === undefined ? undefined : typeof v.turnOrigin === 'string' ? TURN_ORIGINS[v.turnOrigin] ?? null : null;
  if (fromOrigin === null || fromTurn === null) return unrecognized;
  if (fromOrigin !== undefined && fromTurn !== undefined && fromOrigin !== fromTurn) return { kind: 'opener_conflict', origin: 'system' };
  const named = fromOrigin ?? fromTurn;
  if (named !== undefined) return CLASS_LABEL[named];
  const fromSource = typeof v.promptSource === 'string' ? PROMPT_SOURCES[v.promptSource] : undefined;
  return fromSource === undefined ? unrecognized : CLASS_LABEL[fromSource];
}

/** The label a line carrying another agent's envelope takes. */
function envelopeLabel(text: string): ClaudePromptShape | undefined {
  return AGENT_MESSAGE_SHAPES.find(([, prefix]) => text.trimStart().startsWith(prefix))?.[0];
}

/** What a claude-v2 user record is: one disposition for every record. */
type V2Disposition =
  | { as: 'none' }
  | { as: 'context'; thread: string }
  | { as: 'sibling'; thread: string; kind: string; origin: WirePromptOrigin }
  | { as: 'claimant'; opener: boolean; kind: string; origin: WirePromptOrigin };

/**
 * The disposition of a user record that carries no tool result, in order: a delegated agent's record never claims a
 * key and is a summary, a non-prompt or a sibling on its agent's thread; a summary is context; a display-only record
 * that is no summary is unrecognized; a meta record without a turn opener's fields, an interrupt marker without them,
 * a line the capture rules drop and an empty line are no prompt; anything else claims its key.
 */
function v2Disposition(v: Record<string, unknown>, text: string, role: ParserInput['role'], sessionId: string): V2Disposition {
  const agentId = str(v.agentId);
  const sidechain = v.isSidechain === true;
  if (role === 'subagent' || sidechain || agentId !== undefined) {
    const thread = agentId ?? MAIN_THREAD;
    // Against a registered role: a delegated agent's record carries both of its markers, and the session's own
    // transcript holds none. Where no registration names the role, the record's own markers are all there is.
    const keepsContract = role === undefined || (role === 'subagent' && sidechain && agentId !== undefined);
    if (!keepsContract) return text.trim() === '' ? { as: 'none' } : { as: 'sibling', thread, kind: 'contract_violation', origin: 'system' };
    if (v.isCompactSummary === true) return { as: 'context', thread };
    if (v.isMeta === true || INTERRUPT_MARKERS.has(text.trim()) || text.trim() === '') return { as: 'none' };
    const envelope = envelopeLabel(text);
    if (envelope !== undefined) return { as: 'sibling', thread, kind: envelope, origin: 'agent_dispatch' };
    return v.parentUuid === null
      ? { as: 'sibling', thread, kind: 'sidechain', origin: 'agent_dispatch' }
      : { as: 'sibling', thread, kind: 'unrecognized', origin: 'system' };
  }
  if (v.isCompactSummary === true) return { as: 'context', thread: MAIN_THREAD };
  if (v.isVisibleInTranscriptOnly === true) return { as: 'sibling', thread: MAIN_THREAD, kind: 'unrecognized', origin: 'system' };
  const opener = hasOpener(v);
  if (text.trim() === '') return { as: 'none' };
  if (opener) return { as: 'claimant', opener, ...openerLabel(v) };
  if (v.isMeta === true || INTERRUPT_MARKERS.has(text.trim())) return { as: 'none' };
  const decision = evaluatePromptRules(CAPTURE_RULE_BUNDLES, 'claude-code', { prompt: text, transcriptPath: sessionId, record: v });
  if (decision.action === 'drop') return { as: 'none' };
  const envelope = envelopeLabel(text);
  if (envelope !== undefined) return { as: 'sibling', thread: MAIN_THREAD, kind: envelope, origin: 'agent_dispatch' };
  const origin: WirePromptOrigin = decision.origin === undefined || decision.origin === 'human' ? 'user' : decision.origin;
  return { as: 'claimant', opener, kind: 'unmarked', origin };
}

/** The keys a claude-v2 window's records could claim: the session's own records' `promptId`s, each with its owner's prompt id. */
async function v2ClaimKeys(lines: readonly ParsedLine[], sessionId: string): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  for (const { value } of lines) {
    const key = str(value.promptId);
    if (str(value.type) !== 'user' || key === undefined || keys.has(key) || value.isSidechain === true || str(value.agentId) !== undefined) continue;
    keys.set(key, await claudeRecordIdFor(sessionId, { owner: key }));
  }
  return keys;
}

export const claudeCodeParser: TranscriptParser = {
  agent: 'claude-code',
  fidelity: 'full',
  schemes: ['claude-v1', 'claude-v2'],
  planTags: ['ultraplan'],
  continuation: { parentSessionIdPath: 'session_id', markerPaths: ['isCompactSummary'] },

  async claimKeys(lines, scheme, sessionId) {
    return scheme === 'claude-v2' ? v2ClaimKeys(lines, sessionId) : new Map();
  },

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const { lines: all, sessionId, now, openPromptId } = input;
    const lines = ownedLines(all, sessionId, claudeCodeParser.continuation);
    const events: DerivedEvent[] = [];
    const continuation = parserContinuation(input);
    const pending = continuation.pending;
    let promptId: string | undefined = openPromptId;
    let reply: { parts: ReplyPart[]; promptId?: string } | null = null;
    let planPosition = continuation.position;
    const v2 = input.scheme === 'claude-v2';
    // The keys this traversal claims for itself, by the record that claimed each; the stored owners are read, never written.
    const claimed = input.claims ?? new Map<string, string>();
    const ownerOf = (key: string): string | undefined => claimed.get(key) ?? input.owners?.get(key)?.record;

    /** A claude-v2 prompt row, with the source its identity is derived from; it becomes the current prompt unless it is context. */
    const v2Prompt = async (row: { id: string; text: string; origin: WirePromptOrigin; kind: string; claim: PromptClaim; key?: string; thread: string; record?: string },
      createdAt: number, offset: number): Promise<void> => {
      await flushReply();
      events.push({ kind: 'prompt', payload: {
        promptId: row.id, text: row.text, origin: row.origin, promptKind: row.kind, claim: row.claim,
        ...(row.key === undefined ? {} : { sourceKey: row.key }), sourceThread: row.thread, ...(row.record === undefined ? {} : { sourceRecord: row.record }),
      }, createdAt, offset, ...(row.claim === 'context' ? { opensTurn: false } : {}) });
      if (row.claim !== 'context') promptId = row.id;
    };

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      for (const chunk of held.parts) {
        events.push({
          kind: 'response',
          payload: { promptId: held.promptId, text: chunk.text },
          source: chunk.source,
          createdAt: chunk.createdAt,
          offset: chunk.offset,
        });
      }
    };

    for (const { value, offset, undatedAt } of lines) {
      const createdAt = lineTime(value, now, undatedAt);
      const type = str(value.type);
      const message = isBlock(value.message) ? value.message : undefined;

      if (v2 && type === 'user' && !blocksOf(message?.content).some((b) => b.type === 'tool_result')) {
        const text = textOf(message?.content);
        const disposition = v2Disposition(value, text, input.role, sessionId);
        const uuid = str(value.uuid);
        const key = str(value.promptId);
        if (disposition.as === 'none') continue;
        if (disposition.as === 'claimant' && key !== undefined) {
          const owner = ownerOf(key);
          if (owner === undefined || owner === uuid) {
            if (uuid !== undefined) claimed.set(key, uuid);
            await v2Prompt({ id: await claudeRecordIdFor(sessionId, { owner: key }), text, origin: disposition.origin, kind: disposition.kind,
              claim: 'owner', key, thread: MAIN_THREAD, record: uuid }, createdAt, offset);
            continue;
          }
        }
        if (uuid === undefined) continue;
        const thread = disposition.as === 'claimant' ? MAIN_THREAD : disposition.thread;
        const claim: PromptClaim = disposition.as === 'context' ? 'context' : disposition.as === 'claimant' && disposition.opener && key !== undefined ? 'reused' : 'sibling';
        const label = disposition.as === 'context' ? { kind: 'compact_summary', origin: 'system' as const }
          : disposition.as === 'claimant' && !disposition.opener ? { kind: envelopeLabel(text) ?? 'unrecognized', origin: envelopeLabel(text) === undefined ? 'system' as const : 'agent_dispatch' as const }
          : { kind: disposition.kind, origin: disposition.origin };
        await v2Prompt({ id: await claudeRecordIdFor(sessionId, { thread, uuid }), text, ...label, claim, key, thread, record: uuid }, createdAt, offset);
        continue;
      }

      if (type === 'user' && namesPrompt(value)) {
        await flushReply();
        const text = textOf(message?.content);
        const shape = promptShape(value, text);
        const key = shape === 'user_prompt' ? str(value.promptId) : str(value.uuid);
        if (text.trim() !== '' && key !== undefined) {
          promptId = await promptIdFor(sessionId, shape, key);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: shape === 'user_prompt' ? 'user' : 'agent_dispatch', promptKind: shape }, createdAt, offset });
        }
        continue;
      }

      if (type === 'attachment' && isBlock(value.attachment) && str(value.attachment.type) === 'queued_command') {
        await flushReply();
        const text = textOf(value.attachment.prompt);
        const key = str(value.uuid);
        if (text.trim() !== '' && key !== undefined && v2) {
          await v2Prompt({ id: await claudeRecordIdFor(sessionId, { queued: key }), text, origin: 'user', kind: 'queued_command',
            claim: 'owner', key, thread: str(value.agentId) ?? MAIN_THREAD, record: key }, createdAt, offset);
        } else if (text.trim() !== '' && key !== undefined) {
          promptId = await promptIdFor(sessionId, 'queued_command', key);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'queued_command' }, createdAt, offset });
        }
        continue;
      }

      if (type === 'user') {
        // A tool result closes the call it names and is not a turn boundary.
        for (const block of blocksOf(message?.content)) {
          if (block.type !== 'tool_result') continue;
          const source = optionalRecordSource(input, this.agent, { kind: 'tool-call', record: value, result: block, role: 'result' });
          if (source === undefined) continue;
          const call = await callForResult(input, this.agent, source, pending, { promptId, createdAt, offset });
          const failed = block.is_error === true;
          const output = textOf(block.content).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
          events.push({
            kind: failed ? 'tool.failure' : 'tool.use', source, legacyId: call.toolCallId,
            payload: {
              toolCallId: call.toolCallId,
              promptId: call.promptId,
              toolName: call.toolName,
              input: call.input,
              ...(output === '' ? {} : { output }),
              success: !failed,
              ...(failed ? { errorMessage: output === '' ? 'tool failed' : output } : {}),
            },
            createdAt: call.createdAt,
            offset: input.state === undefined ? call.offset : offset,
          });
        }
        continue;
      }

      if (type !== 'assistant') continue;

      for (const [blockIndex, block] of (Array.isArray(message?.content) ? message.content : []).entries()) {
        if (!isBlock(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          if (reply === null) reply = { parts: [], promptId };
          reply.parts.push({ text: block.text, offset, createdAt, source: recordSource(input, this.agent, { kind: 'response', record: value, block: blockIndex }) });
          const plans = await plansInText(block.text, claudeCodeParser.planTags, input, this.agent, value, { promptId, offset, createdAt }, planPosition, blockIndex);
          events.push(...plans.events);
          planPosition = plans.next;
          continue;
        }
        if (block.type === 'tool_use') {
          const name = str(block.name);
          if (name === undefined) continue;
          const source = optionalRecordSource(input, this.agent, { kind: 'tool-call', record: value, call: block, role: 'call' });
          if (source === undefined || !('key' in source)) continue;
          const id = source.key;
          pending.set(id, {
            toolCallId: await recordId(input, this.agent, { kind: 'tool-call', source, offset }),
            toolName: name.slice(0, TOOL_NAME_CHARS),
            input: block.input ?? {},
            promptId,
            createdAt,
            offset,
          });
        }
      }
    }

    await flushReply();


    continuation.save(planPosition);
    return events.sort((a, b) => a.offset - b.offset);
  },
};
