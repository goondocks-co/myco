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

/** How an agent's prompts are named: a key the harness puts in both hook input and transcript, an id the hook mints and the agent's plugin stamps on its transcript, an id the hook mints for the rows it writes itself, or one only the transcript side derives. */
export const PROMPT_IDENTITY_KINDS = ['harness-key', 'stamped', 'hook-owned', 'transcript-only'] as const;
export type PromptIdentityKind = (typeof PROMPT_IDENTITY_KINDS)[number];

/** Every derivation a prompt id has ever been made by, with the kinds it serves. `minted` ids are the hook's own random ids. */
export const PROMPT_ID_SCHEMES = {
  /** Claude Code: the hook's `prompt_id` is the transcript's `promptId`; a queued command keys on its record's uuid. */
  'claude-v1': { kinds: ['harness-key'], derivation: 'derived' },
  /** A transcript the Deployment parses by line position: Codex, Cursor and Pi. */
  'offset-v1': { kinds: ['transcript-only'], derivation: 'derived' },
  /** A plugin-written transcript carrying the hook's stamped id, or its line position where no hook answered: OpenCode and Cline. */
  'stamp-or-offset-v1': { kinds: ['stamped'], derivation: 'derived' },
  /** Prompts the member reads from a harness transcript itself: Antigravity's backfill and hook-owned supplementation. */
  'member-transcript-v1': { kinds: ['transcript-only'], derivation: 'derived' },
  /** A Myco 1.4 vault's prompt, imported. */
  'legacy-v1': { kinds: [], derivation: 'derived' },
  /** The hook's own time-ordered id, for an agent whose hooks write its turn rows. */
  'hook-mint-v1': { kinds: ['hook-owned'], derivation: 'minted' },
} as const satisfies Record<string, { kinds: readonly PromptIdentityKind[]; derivation: 'derived' | 'minted' }>;
export type PromptIdScheme = keyof typeof PROMPT_ID_SCHEMES;
export const PROMPT_ID_SCHEME_NAMES = Object.keys(PROMPT_ID_SCHEMES) as PromptIdScheme[];

/** The schemes a manifest may declare as its agent's current one. */
export const DECLARABLE_SCHEMES = ['claude-v1', 'offset-v1', 'stamp-or-offset-v1', 'member-transcript-v1', 'hook-mint-v1'] as const satisfies readonly PromptIdScheme[];
export type DeclarableScheme = (typeof DECLARABLE_SCHEMES)[number];

/** The prompt namespaces the offset-named parsers derive under, one per parser. */
export const OFFSET_PROMPT_NAMESPACES = ['codex-prompt', 'cursor-prompt', 'pi-prompt'] as const;
export type OffsetPromptNamespace = (typeof OFFSET_PROMPT_NAMESPACES)[number];

/** The Claude Code record shapes a prompt id keys on. */
export const CLAUDE_PROMPT_SHAPES = ['user_prompt', 'queued_command', 'agent_message', 'teammate_message', 'sidechain'] as const;
export type ClaudePromptShape = (typeof CLAUDE_PROMPT_SHAPES)[number];

/** One derivation request, by scheme. */
export type PromptIdRequest =
  | { scheme: 'claude-v1'; sessionId: string; shape: ClaudePromptShape; key: string }
  | { scheme: 'offset-v1'; namespace: OffsetPromptNamespace; sessionId: string; offset: number }
  | { scheme: 'stamp-or-offset-v1'; sessionId: string; stamp?: string; offset: number }
  | { scheme: 'member-transcript-v1'; sessionId: string; dedupeKey?: string; position: number }
  | { scheme: 'legacy-v1'; projectId: string; legacyId: string };

/** UUIDv5 over the derived-id namespace of the NUL-joined parts, synchronous on the member and a promise on the Deployment. */
export type PromptIdHasher<R> = (...parts: string[]) => R;

/** Statically total over the derived schemes: a scheme the switch does not derive fails to compile. */
const underived = (request: never): never => { throw new Error(`no derivation for ${JSON.stringify(request)}`); };

/**
 * The canonical id of one prompt under its scheme. The only prompt-id derivation: a `uuidv5`/`deriveId` of a prompt
 * anywhere else fails `tests/meta/prompt-identity-sources.test.ts`. A stamped id is the hook's own and is taken as it is.
 */
export function canonicalPromptId<R>(hash: PromptIdHasher<R>, request: PromptIdRequest): R | string {
  switch (request.scheme) {
    case 'claude-v1':
      return hash('queued-prompt', request.sessionId, `${request.shape}|${request.key}`);
    case 'offset-v1':
      return hash(request.namespace, request.sessionId, String(request.offset));
    case 'stamp-or-offset-v1':
      return request.stamp ?? hash('prompt', request.sessionId, String(request.offset));
    case 'member-transcript-v1':
      return request.dedupeKey === undefined
        ? hash('transcript-prompt', request.sessionId, String(request.position))
        : hash('queued-prompt', request.sessionId, request.dedupeKey);
    case 'legacy-v1':
      return hash('legacy', request.projectId, 'prompt', request.legacyId);
    default:
      return underived(request);
  }
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
}

/**
 * The request a prompt hook derives its submission's id with, for an agent whose harness hands the hook the key the
 * transcript also carries: null for any other agent, and for a submission the harness sent no key for.
 */
export function hookPromptRequest(declaration: PromptIdentityDeclaration, sessionId: string, key: string | undefined): PromptIdRequest | null {
  if (declaration.kind !== 'harness-key' || key === undefined) return null;
  switch (declaration.scheme) {
    case 'claude-v1': return { scheme: 'claude-v1', sessionId, shape: 'user_prompt', key };
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
