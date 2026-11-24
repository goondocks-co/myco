/**
 * The secret slots a Deployment stores, and what each one is used for.
 *
 * One slot means one thing. A key stored for one use never becomes the key for
 * another: an OpenAI key stored for embeddings is not a login for the runs of
 * a harness whose manifest declares a slot of its own (#1212). Which harness runs read a slot is
 * `HARNESS_CREDENTIALS` (`harness-providers.ts`), so the words a surface shows
 * for a slot are built from the table the server reads (`slotUse`), and cannot
 * name a use the server does not make.
 */
import { HARNESS_CREDENTIALS } from './harness-providers.js';
import type { ProviderSlotName } from './provider-slots.js';
import { RUNNER_OWN_SLOTS } from './runner-harnesses.generated.js';

/** A slot a harness's manifest declares as its own (`runner.credential.slot: own`), named after the harness. */
type HarnessOwnSlotName = (typeof RUNNER_OWN_SLOTS)[number]['name'];
export type SecretSlotName = ProviderSlotName | HarnessOwnSlotName | 'single-turn';

export interface SecretSlot {
  name: SecretSlotName;
  /** The account the key belongs to, as the settings page names it. */
  label: string;
  /** What reads it besides harness runs, in the reader's words, or null where nothing else does. */
  alsoUsedFor: string | null;
}

/** Every slot, in the order the settings page lists them: the harnesses' own slots follow Anthropic's. */
export const SECRET_SLOTS: readonly SecretSlot[] = [
  { name: 'anthropic', label: 'Anthropic', alsoUsedFor: null },
  ...RUNNER_OWN_SLOTS.map((slot): SecretSlot => ({ name: slot.name, label: slot.label, alsoUsedFor: null })),
  { name: 'openai', label: 'OpenAI', alsoUsedFor: 'search by meaning, when search uses OpenAI' },
  { name: 'openrouter', label: 'OpenRouter', alsoUsedFor: 'search by meaning, when search uses OpenRouter' },
  { name: 'single-turn', label: 'Own model address', alsoUsedFor: 'quick jobs sent to your own model address' },
];

export const SECRET_SLOT_NAMES: readonly SecretSlotName[] = SECRET_SLOTS.map((slot) => slot.name);
export const secretSlotLabel = (name: SecretSlotName): string => SECRET_SLOTS.find(slot => slot.name === name)!.label;

export const isSecretSlotName = (value: string): value is SecretSlotName => (SECRET_SLOT_NAMES as readonly string[]).includes(value);

/** The harnesses whose Deployment-dispatched runs read `slot`, by id. */
export function harnessesReading(slot: SecretSlotName): string[] {
  return Object.entries(HARNESS_CREDENTIALS).filter(([, declared]) => declared.slot === slot).map(([id]) => id);
}

/** What a stored slot is for, in one sentence: the agents that use it when a stored key is chosen for their work, and its other declared uses. */
export function slotUse(slot: SecretSlot, label: (harness: string) => string): string {
  const harnesses = harnessesReading(slot.name).map(label);
  const runs = harnesses.length === 0 ? null
    : `${list(harnesses)} ${harnesses.length === 1 ? 'uses' : 'use'} it for Myco’s work when you choose a stored key instead of each runner’s own sign-in`;
  const other = slot.alsoUsedFor === null ? null : `${runs === null ? 'Used' : 'also used'} for ${slot.alsoUsedFor}`;
  const parts = [runs, other].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Nothing on this server reads it.' : `${parts.join('; ')}.`;
}

const list = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
