/**
 * A prompt's identity: where each agent's comes from, and the one derivation of it.
 *
 * Every agent declares in its capture manifest how its prompts are named (`promptIdentity`), and the declaration names
 * one scheme of this registry. Both the member's hooks and the Deployment's parsers derive a prompt id through
 * `canonicalPromptId` and nothing else, so a prompt the hook saw and the same prompt the transcript holds carry one id.
 * A scheme is never changed once rows exist under it: a new derivation is a new scheme.
 *
 * The UUIDv5 itself is the caller's: the member hashes synchronously and the Deployment through Web Crypto, over the
 * same namespace and the same NUL-joined parts (`tests/member/derived-id-parity.test.ts`).
 */

import type { OffsetPromptNamespace } from './record-identity.js';

/** How an agent's prompts are named: a key the harness puts in both hook input and transcript, an id the hook mints and the agent's plugin stamps on its transcript, an id the hook mints for the rows it writes itself, or one only the transcript side derives. */
export const PROMPT_IDENTITY_KINDS = ['harness-key', 'stamped', 'hook-owned', 'transcript-only'] as const;
export type PromptIdentityKind = (typeof PROMPT_IDENTITY_KINDS)[number];

/**
 * Every derivation a prompt id has ever been made by, with the kinds it serves. `minted` ids are the hook's own random
 * ids. `generation` is the revision of a scheme's derivation a parser checkpoint records; it is fixed, and a changed
 * derivation is a new scheme. `granularity: 'turn'` names a harness key that names a turn, of which only the opener is
 * one submission. `hookIdentity` names the scheme a hook derives this scheme's key-named prompts by, where the two
 * derive the same id for them: a hook names its prompt under that scheme, and a transcript pinned to this one shares it.
 */
export const PROMPT_ID_SCHEMES = {
  /** Claude Code: the hook's `prompt_id` is the transcript's `promptId`; a queued command keys on its record's uuid. */
  'claude-v1': { kinds: ['harness-key'], derivation: 'derived', generation: 2 },
  /**
   * Claude Code, every record kept: the first claimant of a `promptId` owns it under claude-v1's id, and every other
   * prompt-shaped record (a later submission reusing the key, another agent's line, a compaction summary) is keyed on
   * its own thread and uuid (`parsers/claude-code.ts`).
   */
  'claude-v2': { kinds: ['harness-key'], derivation: 'derived', generation: 1, hookIdentity: 'claude-v1' },
  /** A transcript the Deployment parses by line position: Codex before its turn key, Cursor and Pi. */
  'offset-v2': { kinds: ['transcript-only'], derivation: 'derived', generation: 1, viewOnly: true },
  'stamp-or-offset-v2': { kinds: ['stamped'], derivation: 'derived', generation: 1, viewOnly: true },
  'offset-v1': { kinds: ['transcript-only'], derivation: 'derived', generation: 1 },
  /** A plugin-written transcript carrying the hook's stamped id, or its line position where no hook answered: OpenCode and Cline. */
  'stamp-or-offset-v1': { kinds: ['stamped'], derivation: 'derived', generation: 1 },
  /**
   * Codex: the hook's `turn_id` is the rollout's turn; the turn's first submission is its opener, named by the turn
   * alone, and every later submission of the turn by its acceptance order, or its line position where the rollout
   * records none.
   */
  'codex-turn-v1': { kinds: ['harness-key'], derivation: 'derived', generation: 1, granularity: 'turn' },
  /** Prompts the member reads from a harness transcript itself: Antigravity's backfill and hook-owned supplementation. */
  'member-transcript-v1': { kinds: ['transcript-only'], derivation: 'derived', generation: 1 },
  /** A Myco 1.4 vault's prompt, imported. */
  'legacy-v1': { kinds: [], derivation: 'derived', generation: 1 },
  /** The hook's own time-ordered id, for an agent whose hooks write its turn rows. */
  'hook-mint-v1': { kinds: ['hook-owned'], derivation: 'minted', generation: 1 },
} as const satisfies Record<string, {
  kinds: readonly PromptIdentityKind[]; derivation: 'derived' | 'minted'; generation: number; granularity?: 'turn'; hookIdentity?: string; viewOnly?: boolean;
}>;
export type PromptIdScheme = keyof typeof PROMPT_ID_SCHEMES;
export const PROMPT_ID_SCHEME_NAMES = Object.keys(PROMPT_ID_SCHEMES) as PromptIdScheme[];
export const isPromptIdScheme = (value: unknown): value is PromptIdScheme =>
  typeof value === 'string' && Object.hasOwn(PROMPT_ID_SCHEMES, value);
/** Whether a scheme's harness key names a turn rather than one submission. */
export const turnGrained = (scheme: PromptIdScheme): boolean => 'granularity' in PROMPT_ID_SCHEMES[scheme];
/** The scheme a hook names a prompt of this scheme under: its `hookIdentity`, or the scheme itself. */
export const hookScheme = (scheme: PromptIdScheme): PromptIdScheme => {
  const entry = PROMPT_ID_SCHEMES[scheme];
  return 'hookIdentity' in entry && isPromptIdScheme(entry.hookIdentity) ? entry.hookIdentity : scheme;
};
/** The schemes a hook names a prompt under: every scheme that is its own `hookScheme`. */
export const HOOK_NAMED_SCHEMES: readonly PromptIdScheme[] = PROMPT_ID_SCHEME_NAMES.filter((scheme) => !('viewOnly' in PROMPT_ID_SCHEMES[scheme]) && hookScheme(scheme) === scheme);

/** The schemes a manifest may declare as its agent's current one. */
export const DECLARABLE_SCHEMES = ['claude-v1', 'claude-v2', 'offset-v1', 'stamp-or-offset-v1', 'codex-turn-v1', 'member-transcript-v1', 'hook-mint-v1'] as const satisfies readonly PromptIdScheme[];
export type DeclarableScheme = (typeof DECLARABLE_SCHEMES)[number];

export { OFFSET_PROMPT_NAMESPACES } from './record-identity.js';
export type { OffsetPromptNamespace } from './record-identity.js';

/** The Claude Code record shapes a prompt id keys on. */
export const CLAUDE_PROMPT_SHAPES = ['user_prompt', 'queued_command', 'agent_message', 'teammate_message', 'sidechain'] as const;
export type ClaudePromptShape = (typeof CLAUDE_PROMPT_SHAPES)[number];

/**
 * What a claude-v2 id is derived from: the `promptId` its first claimant owns, a queued command's record uuid, or any
 * other kept record's thread (`agentId`, or `main` for the session's own transcript) and uuid.
 */
export type ClaudeRecordKey = { owner: string } | { queued: string } | { thread: string; uuid: string };
/** The thread of a record in the session's own transcript rather than a delegated agent's. */
export const MAIN_THREAD = 'main';

/**
 * How a parsed prompt row holds its harness key: it owns the key, or it is a later submission reusing an owned key,
 * another line carrying the key, or harness context that is no submission.
 */
export const PROMPT_CLAIMS = ['owner', 'reused', 'sibling', 'context'] as const;
export type PromptClaim = (typeof PROMPT_CLAIMS)[number];
export const isPromptClaim = (value: unknown): value is PromptClaim => (PROMPT_CLAIMS as readonly unknown[]).includes(value);

/** Where one submission sits in its Codex turn: the turn's opener, or a later one by its acceptance order or line position. */
export type TurnSubmission = { opener: true } | { order: number } | { offset: number };

/** One derivation request, by scheme. */
export type PromptIdRequest =
  | { scheme: 'offset-v2'; namespace: OffsetPromptNamespace; sessionId: string; transcriptId: string; offset: number }
  | { scheme: 'stamp-or-offset-v2'; sessionId: string; transcriptId: string; stamp?: string; offset: number }
  | { scheme: 'claude-v1'; sessionId: string; shape: ClaudePromptShape; key: string }
  | { scheme: 'claude-v2'; sessionId: string; record: ClaudeRecordKey }
  | { scheme: 'offset-v1'; namespace: OffsetPromptNamespace; sessionId: string; offset: number }
  | { scheme: 'stamp-or-offset-v1'; sessionId: string; stamp?: string; offset: number }
  | { scheme: 'codex-turn-v1'; sessionId: string; turnId: string; submission: TurnSubmission }
  | { scheme: 'member-transcript-v1'; sessionId: string; dedupeKey?: string; position: number }
  | { scheme: 'legacy-v1'; projectId: string; legacyId: string };

/** UUIDv5 over the derived-id namespace of the NUL-joined parts, synchronous on the member and a promise on the Deployment. */
export type PromptIdHasher<R> = (...parts: string[]) => R;

export { canonicalPromptId } from './record-identity.js';

/** The most of a prompt's text a context ask carries, and what a prompt's key hash covers. */
export const PROMPT_KEY_TEXT_MAX_CHARS = 16_384;

/**
 * A prompt's key hash: the SHA-256 of its text, as the capture rules leave it, cut to what an ask carries. A receipt
 * records it of the text it was asked with, and a parsed prompt of the text its transcript holds, so the two compare
 * where both name one prompt. It is a signal that one id carried two texts, never a way to link records.
 */
export function promptKeyHash<R>(sha256: (text: string) => R, text: string): R {
  return sha256(text.slice(0, PROMPT_KEY_TEXT_MAX_CHARS));
}

/** The longest harness prompt key a derivation takes. */
export const PROMPT_KEY_MAX_CHARS = 128;

/**
 * A harness prompt key as the derivation takes it: a non-empty string of at most `PROMPT_KEY_MAX_CHARS`, trimmed, or
 * undefined for anything else. An absent key is a fact about the submission, never replaced by a minted one.
 */
export function normalizePromptKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return key.length > 0 && key.length <= PROMPT_KEY_MAX_CHARS && !/[\u0000-\u001F\u007F]/.test(key) ? key : undefined;
}

/** What an agent's manifest declares of its prompts' identity, as the shared capture rules carry it. */
export interface PromptIdentityDeclaration {
  kind: PromptIdentityKind;
  scheme: DeclarableScheme;
  /** `harness-key` only: where the key sits in the hook's input and in the transcript record. */
  hookKey?: string;
  transcriptKey?: string;
  /** `turn` where the key names a turn rather than one submission (the scheme's own granularity). */
  granularity?: 'turn';
  /** The scheme that read the agent's transcripts before each was pinned to one, where it is not `scheme`. */
  readBeforePin?: DeclarableScheme;
}

/**
 * The request a prompt hook derives its submission's id with, for an agent whose harness hands the hook the key the
 * transcript also carries: null for any other agent, and for a submission the harness sent no key for. A turn key
 * derives the turn opener's id: whether this submission opens its turn is the caller's to decide.
 */
export function hookPromptRequest(declaration: PromptIdentityDeclaration, sessionId: string, key: string | undefined): PromptIdRequest | null {
  if (declaration.kind !== 'harness-key' || key === undefined) return null;
  switch (declaration.scheme) {
    case 'claude-v1':
    case 'claude-v2': return { scheme: 'claude-v1', sessionId, shape: 'user_prompt', key };
    case 'codex-turn-v1': return { scheme: 'codex-turn-v1', sessionId, turnId: key, submission: { opener: true } };
    default: return null;
  }
}

/**
 * Why a context answer names no prompt: the harness sent no key for this submission, the submission steered a turn
 * whose key names only its opener, the session's transcript is named under a scheme the hook does not share, or the
 * agent's prompts are named by its transcript alone.
 */
export const PROMPT_SCOPE_REASONS = ['absent_key', 'steering', 'scheme', 'transcript_only'] as const;
export type PromptScopeReason = (typeof PROMPT_SCOPE_REASONS)[number];
export const isPromptScopeReason = (value: unknown): value is PromptScopeReason =>
  (PROMPT_SCOPE_REASONS as readonly unknown[]).includes(value);

/** How a context ask names its prompt: `v1` asks carry the identity marker and their own instant; `legacy` asks are an older member's. */
export const ASK_PROTOCOLS = ['legacy', 'v1'] as const;
export type AskProtocol = (typeof ASK_PROTOCOLS)[number];
/** The marker a `v1` ask carries. */
export const ASK_IDENTITY_MARKER = 1;

/** The Deployment feature that admits `v1` asks and the delivery event; a member sends neither to a Deployment that does not name it. */
export const PROMPT_IDENTITY_FEATURE = 'prompt-identity';
/**
 * The Deployment feature that pins each transcript's scheme and reads it at ask time: a member names the scheme its
 * prompt ids are derived by, and claims a turn-grained key, only for a Deployment that names it.
 */
export const PROMPT_SCHEME_FEATURE = 'prompt-scheme';
/** The event a hook that rendered a cached answer sends, naming the rows it rendered by their ids. */
export const CONTEXT_DELIVERED_KIND = 'context.delivered';
/**
 * The session records an answer can carry, each named by its key within the session: what a delivery names so the
 * record outlives the answer that carried it.
 */
export const DELIVERED_SESSION_RECORDS = ['plan-nudge'] as const;
export type DeliveredSessionRecord = (typeof DELIVERED_SESSION_RECORDS)[number];
export const isDeliveredSessionRecord = (value: unknown): value is DeliveredSessionRecord =>
  (DELIVERED_SESSION_RECORDS as readonly unknown[]).includes(value);
