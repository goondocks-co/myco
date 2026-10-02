/**
 * The Deployment secret slots a provider's key fills, which any harness or server use may read. A harness's manifest
 * names one of these as the slot its runs read (`runner.credential.slot`), or declares a slot of its own; the
 * generator refuses any other name.
 */
export const PROVIDER_SLOT_NAMES = ['anthropic', 'openai', 'openrouter', 'github'] as const;

export type ProviderSlotName = (typeof PROVIDER_SLOT_NAMES)[number];
