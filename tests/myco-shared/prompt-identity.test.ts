/**
 * The one prompt-id derivation. Each scheme keeps the derivation its rows were written under, so these pin the ids
 * the existing parsers and member paths produced before they were routed through the registry.
 */
import { describe, expect, it } from 'bun:test';
import {
  canonicalPromptId, CLAUDE_PROMPT_SHAPES, HOOK_NAMED_SCHEMES, hookPromptRequest, hookScheme, normalizePromptKey, PROMPT_ID_SCHEMES, PROMPT_KEY_MAX_CHARS,
  type PromptIdRequest,
} from '@goondocks/myco-shared/prompt-identity';
import { deriveId } from '@myco/member/envelope.js';
import { uuidv5 } from '@myco-server-worker/hash.js';

const S = 'session-1';
const REQUESTS: Array<[PromptIdRequest, string[]]> = [
  [{ scheme: 'claude-v1', sessionId: S, shape: 'user_prompt', key: 'k' }, ['queued-prompt', S, 'user_prompt|k']],
  [{ scheme: 'claude-v1', sessionId: S, shape: 'queued_command', key: 'u' }, ['queued-prompt', S, 'queued_command|u']],
  [{ scheme: 'claude-v2', sessionId: S, record: { owner: 'k' } }, ['queued-prompt', S, 'user_prompt|k']],
  [{ scheme: 'claude-v2', sessionId: S, record: { queued: 'u' } }, ['queued-prompt', S, 'queued_command|u']],
  [{ scheme: 'claude-v2', sessionId: S, record: { thread: 'main', uuid: 'r' } }, ['queued-prompt', S, 'record|main|r']],
  [{ scheme: 'claude-v2', sessionId: S, record: { thread: 'a7f1', uuid: 'r' } }, ['queued-prompt', S, 'record|a7f1|r']],
  [{ scheme: 'offset-v1', namespace: 'codex-prompt', sessionId: S, offset: 12 }, ['codex-prompt', S, '12']],
  [{ scheme: 'offset-v1', namespace: 'cursor-prompt', sessionId: S, offset: 0 }, ['cursor-prompt', S, '0']],
  [{ scheme: 'offset-v1', namespace: 'pi-prompt', sessionId: S, offset: 7 }, ['pi-prompt', S, '7']],
  [{ scheme: 'stamp-or-offset-v1', sessionId: S, offset: 9 }, ['prompt', S, '9']],
  [{ scheme: 'codex-turn-v1', sessionId: S, turnId: 't1', submission: { opener: true } }, ['codex-turn', S, 't1', 'opener']],
  [{ scheme: 'codex-turn-v1', sessionId: S, turnId: 't1', submission: { order: 4 } }, ['codex-turn', S, 't1', 'order|4']],
  [{ scheme: 'codex-turn-v1', sessionId: S, turnId: 't1', submission: { offset: 812 } }, ['codex-turn', S, 't1', 'offset|812']],
  [{ scheme: 'member-transcript-v1', sessionId: S, position: 3 }, ['transcript-prompt', S, '3']],
  [{ scheme: 'member-transcript-v1', sessionId: S, dedupeKey: 'queued_command|u', position: 3 }, ['queued-prompt', S, 'queued_command|u']],
  [{ scheme: 'legacy-v1', projectId: 'proj_1', legacyId: 'old' }, ['legacy', 'proj_1', 'prompt', 'old']],
];

describe('canonicalPromptId', () => {
  it('derives every scheme from the parts its rows were written under, the same on the member and the Deployment', async () => {
    for (const [request, parts] of REQUESTS) {
      const member = canonicalPromptId(deriveId, request);
      expect({ scheme: request.scheme, member }).toEqual({ scheme: request.scheme, member: deriveId(...parts) });
      expect(await canonicalPromptId(uuidv5, request)).toBe(member);
    }
  });

  it('takes a stamped id as it is, and names the derivation of every derived scheme it declares', () => {
    expect(canonicalPromptId(deriveId, { scheme: 'stamp-or-offset-v1', sessionId: S, stamp: 'minted-id', offset: 4 })).toBe('minted-id');
    const derived = Object.entries(PROMPT_ID_SCHEMES).filter(([, s]) => s.derivation === 'derived').map(([name]) => name).sort();
    expect([...new Set(REQUESTS.map(([r]) => r.scheme as string))].sort()).toEqual(derived);
  });

  it('derives a hook\'s id only from a key its agent declares, and names no prompt for a submission without one', () => {
    const claude = { kind: 'harness-key', scheme: 'claude-v1', hookKey: 'prompt_id', transcriptKey: 'promptId' } as const;
    expect(hookPromptRequest(claude, S, 'k')).toEqual({ scheme: 'claude-v1', sessionId: S, shape: 'user_prompt', key: 'k' });
    expect(hookPromptRequest(claude, S, undefined)).toBeNull();
    expect(hookPromptRequest({ kind: 'transcript-only', scheme: 'offset-v1' }, S, 'k')).toBeNull();
    const codex = { kind: 'harness-key', scheme: 'codex-turn-v1', hookKey: 'turn_id', transcriptKey: 'turn_context.payload.turn_id', granularity: 'turn' } as const;
    expect(hookPromptRequest(codex, S, 't1')).toEqual({ scheme: 'codex-turn-v1', sessionId: S, turnId: 't1', submission: { opener: true } });
    expect(hookPromptRequest(codex, S, undefined)).toBeNull();
  });

  it('derives a claude-v2 owner and queued command byte-equal to claude-v1, and every other record in a namespace claude-v1 never uses', () => {
    for (const key of ['k', '07a6ad62-e77a-4522-a509-eb61b542390d']) {
      expect(canonicalPromptId(deriveId, { scheme: 'claude-v2', sessionId: S, record: { owner: key } }))
        .toBe(canonicalPromptId(deriveId, { scheme: 'claude-v1', sessionId: S, shape: 'user_prompt', key }));
      expect(canonicalPromptId(deriveId, { scheme: 'claude-v2', sessionId: S, record: { queued: key } }))
        .toBe(canonicalPromptId(deriveId, { scheme: 'claude-v1', sessionId: S, shape: 'queued_command', key }));
    }
    expect((CLAUDE_PROMPT_SHAPES as readonly string[]).includes('record')).toBe(false);
    // Two threads holding one record uuid are two records.
    expect(canonicalPromptId(deriveId, { scheme: 'claude-v2', sessionId: S, record: { thread: 'a', uuid: 'r' } }))
      .not.toBe(canonicalPromptId(deriveId, { scheme: 'claude-v2', sessionId: S, record: { thread: 'b', uuid: 'r' } }));
  });

  it('names a claude-v2 hook\'s prompt under claude-v1, the scheme its hook derives by, and keeps the wire\'s scheme list', () => {
    const claude = { kind: 'harness-key', scheme: 'claude-v2', hookKey: 'prompt_id', transcriptKey: 'promptId' } as const;
    expect(hookPromptRequest(claude, S, 'k')).toEqual({ scheme: 'claude-v1', sessionId: S, shape: 'user_prompt', key: 'k' });
    expect(hookScheme('claude-v2')).toBe('claude-v1');
    expect(hookScheme('codex-turn-v1')).toBe('codex-turn-v1');
    expect([...HOOK_NAMED_SCHEMES].sort()).toEqual(['claude-v1', 'codex-turn-v1', 'hook-mint-v1', 'legacy-v1', 'member-transcript-v1', 'offset-v1', 'stamp-or-offset-v1']);
  });

  it('normalizes a harness key to a trimmed bounded string, and anything else to none', () => {
    expect(normalizePromptKey(' abc ')).toBe('abc');
    for (const value of [undefined, null, 7, '', '   ', 'a'.repeat(PROMPT_KEY_MAX_CHARS + 1), 'a\nb']) expect(normalizePromptKey(value)).toBeUndefined();
  });
});
