/**
 * The secret slots a Deployment stores, and what each one is used for.
 *
 * One slot means one thing. A key stored for one use never becomes the key for
 * another: an OpenAI key stored for embeddings is not a login for Codex runs,
 * which read a slot of their own (#1212). Which harness runs read a slot is
 * `HARNESS_CREDENTIALS` (`harness-providers.ts`), so the words a surface shows
 * for a slot are built from the table the server reads (`slotUse`), and cannot
 * name a use the server does not make.
 */
import { HARNESS_CREDENTIALS } from './harness-providers.js';

export type SecretSlotName = 'anthropic' | 'codex' | 'openai' | 'openrouter' | 'github';

export interface SecretSlot {
  name: SecretSlotName;
  /** The account the key belongs to, as the settings page names it. */
  label: string;
  /** What reads it besides harness runs, in the reader's words, or null where nothing else does. */
  alsoUsedFor: string | null;
}

/** Every slot, in the order the settings page lists them. */
export const SECRET_SLOTS: readonly SecretSlot[] = [
  { name: 'anthropic', label: 'Anthropic', alsoUsedFor: 'the work this server runs itself, when its model provider is Anthropic' },
  { name: 'codex', label: 'Codex (OpenAI)', alsoUsedFor: null },
  { name: 'openai', label: 'OpenAI', alsoUsedFor: 'embeddings, when the embedding provider is OpenAI' },
  { name: 'openrouter', label: 'OpenRouter', alsoUsedFor: 'embeddings, when the embedding provider is OpenRouter' },
  { name: 'github', label: 'GitHub', alsoUsedFor: null },
];

export const SECRET_SLOT_NAMES: readonly SecretSlotName[] = SECRET_SLOTS.map((slot) => slot.name);

export const isSecretSlotName = (value: string): value is SecretSlotName => (SECRET_SLOT_NAMES as readonly string[]).includes(value);

/** The harnesses whose Deployment-dispatched runs read `slot`, by id. */
export function harnessesReading(slot: SecretSlotName): string[] {
  return Object.entries(HARNESS_CREDENTIALS).filter(([, declared]) => declared.slot === slot).map(([id]) => id);
}

/**
 * What a slot is used for, in one sentence: the harness runs that read it, which
 * run under each worker's own login while it is empty, and anything else that
 * reads it. `label` names a harness by its id.
 */
export function slotUse(slot: SecretSlot, label: (harness: string) => string): string {
  const harnesses = harnessesReading(slot.name).map(label);
  const runs = harnesses.length === 0 ? null
    : `${list(harnesses)} ${harnesses.length === 1 ? 'uses' : 'use'} this key for Myco’s work in place of the machine’s own sign-in; while it is empty ${harnesses.length === 1 ? 'it uses' : 'they use'} each machine’s own sign-in`;
  const other = slot.alsoUsedFor === null ? null : `${runs === null ? 'Used' : 'Also used'} for ${slot.alsoUsedFor}`;
  const parts = [runs, other].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Nothing on this server reads it.' : `${parts.join('. ')}.`;
}

const list = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
