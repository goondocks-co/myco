/**
 * The one prompt-id derivation. Each scheme keeps the derivation its rows were written under, so these pin the ids
 * the existing parsers and member paths produced before they were routed through the registry.
 */
import { describe, expect, it } from 'bun:test';
import {
  canonicalPromptId, hookPromptRequest, normalizePromptKey, PROMPT_ID_SCHEMES, PROMPT_KEY_MAX_CHARS, type PromptIdRequest,
} from '@goondocks/myco-shared/prompt-identity';
import { deriveId } from '@myco/member/envelope.js';
import { uuidv5 } from '@myco-server-worker/hash.js';

const S = 'session-1';
const REQUESTS: Array<[PromptIdRequest, string[]]> = [
  [{ scheme: 'claude-v1', sessionId: S, shape: 'user_prompt', key: 'k' }, ['queued-prompt', S, 'user_prompt|k']],
  [{ scheme: 'claude-v1', sessionId: S, shape: 'queued_command', key: 'u' }, ['queued-prompt', S, 'queued_command|u']],
  [{ scheme: 'offset-v1', namespace: 'codex-prompt', sessionId: S, offset: 12 }, ['codex-prompt', S, '12']],
  [{ scheme: 'offset-v1', namespace: 'cursor-prompt', sessionId: S, offset: 0 }, ['cursor-prompt', S, '0']],
  [{ scheme: 'offset-v1', namespace: 'pi-prompt', sessionId: S, offset: 7 }, ['pi-prompt', S, '7']],
  [{ scheme: 'stamp-or-offset-v1', sessionId: S, offset: 9 }, ['prompt', S, '9']],
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
  });

  it('normalizes a harness key to a trimmed bounded string, and anything else to none', () => {
    expect(normalizePromptKey(' abc ')).toBe('abc');
    for (const value of [undefined, null, 7, '', '   ', 'a'.repeat(PROMPT_KEY_MAX_CHARS + 1), 'a\nb']) expect(normalizePromptKey(value)).toBeUndefined();
  });
});
