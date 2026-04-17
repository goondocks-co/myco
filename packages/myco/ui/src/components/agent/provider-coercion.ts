/**
 * Bidirectional coercion between the three provider-config shapes used in
 * the UI:
 *
 *  - Wire shape (camelCase, as persisted on `execution_overrides` / posted
 *    to `/agent/run` — mirrors the daemon's zod schema).
 *  - UI-internal shape (snake_case `ProviderConfig` — matches the on-disk
 *    `myco.yaml` representation and drives the draft hook / selectors).
 *  - TaskRow shape (a narrow subset of fields the task listing endpoint
 *    exposes under `execution.provider`).
 *
 * All three were previously re-implemented inline in `rerun-prefill.ts`,
 * `execution-overrides.ts`, and `RunTaskDialog.tsx`; the duplication was a
 * drift risk (every new provider type needed to be added in three places).
 */

import type { ReasoningLevel } from '@myco/agent/types';
import type { TaskRow } from '../../hooks/use-agent';
import type { ProviderConfig } from '../../hooks/use-providers';

// ---------------------------------------------------------------------------
// Canonical list of provider types understood by the UI
// ---------------------------------------------------------------------------

/**
 * All provider types we accept from the wire. Anything outside this set is
 * coerced to `openai-compatible` (the safest default for unknown backends).
 */
export const KNOWN_PROVIDER_TYPES: ReadonlyArray<ProviderConfig['type']> = [
  'anthropic',
  'ollama',
  'lmstudio',
  'openai',
  'openrouter',
  'openai-compatible',
];

function coerceProviderType(type: string | undefined): ProviderConfig['type'] {
  return KNOWN_PROVIDER_TYPES.includes(type as ProviderConfig['type'])
    ? (type as ProviderConfig['type'])
    : 'openai-compatible';
}

// ---------------------------------------------------------------------------
// Wire shape (camelCase)
// ---------------------------------------------------------------------------

/**
 * Camel-case provider shape the daemon expects on the /agent/run wire
 * (mirrors @myco/agent/types.ProviderConfig). Distinct from the snake_case
 * shape the UI uses internally.
 */
export interface WireProviderConfig {
  runtime?: 'claude-sdk' | 'openai-agents';
  type: ProviderConfig['type'];
  localBackend?: 'ollama' | 'lmstudio';
  baseUrl?: string;
  model?: string;
  reasoningMap?: Partial<Record<ReasoningLevel, string>>;
  contextLength?: number;
}

/**
 * Loose wire provider — tolerates unknown `type` strings and an
 * unconstrained runtime. Used for values coming back off
 * `execution_overrides`, which may predate a type narrowing.
 */
export interface LooseWireProviderConfig {
  runtime?: string;
  type: string;
  localBackend?: 'ollama' | 'lmstudio';
  baseUrl?: string;
  model?: string;
  reasoningMap?: Partial<Record<ReasoningLevel, string>>;
  contextLength?: number;
}

// ---------------------------------------------------------------------------
// Coercers
// ---------------------------------------------------------------------------

/**
 * Convert the UI-internal snake_case ProviderConfig to the camelCase wire
 * shape the daemon's zod schema parses.
 */
export function toWireProvider(
  p: ProviderConfig | undefined,
): WireProviderConfig | undefined {
  if (!p) return undefined;
  const out: WireProviderConfig = { type: p.type };
  if (p.runtime) out.runtime = p.runtime;
  if (p.local_backend) out.localBackend = p.local_backend;
  if (p.base_url) out.baseUrl = p.base_url;
  if (p.model) out.model = p.model;
  if (p.reasoning_map) out.reasoningMap = p.reasoning_map;
  if (p.context_length) out.contextLength = p.context_length;
  return out;
}

/**
 * Convert a wire-shape provider (as persisted on `execution_overrides`) to
 * the UI-internal snake_case shape. Unknown provider types fall back to
 * `openai-compatible`; unknown runtimes are dropped.
 */
export function fromWireProvider(
  wire: LooseWireProviderConfig | undefined,
): ProviderConfig | undefined {
  if (!wire) return undefined;
  const out: ProviderConfig = { type: coerceProviderType(wire.type) };
  if (wire.runtime === 'claude-sdk' || wire.runtime === 'openai-agents') {
    out.runtime = wire.runtime;
  }
  if (wire.localBackend) out.local_backend = wire.localBackend;
  if (wire.baseUrl) out.base_url = wire.baseUrl;
  if (wire.model) out.model = wire.model;
  if (wire.reasoningMap) out.reasoning_map = wire.reasoningMap;
  if (typeof wire.contextLength === 'number') out.context_length = wire.contextLength;
  return out;
}

/** Shape of `TaskRow['execution'].provider` — a narrow subset. */
export type TaskRowProvider = NonNullable<NonNullable<TaskRow['execution']>['provider']>;

/**
 * Convert the narrow `TaskRow.execution.provider` shape (as returned by the
 * task listing endpoint) into the full `ProviderConfig` the draft hook and
 * effective-defaults comparator expect.
 */
export function fromTaskRowProvider(
  provider: TaskRowProvider | undefined,
): ProviderConfig | undefined {
  if (!provider) return undefined;
  const out: ProviderConfig = { type: coerceProviderType(provider.type) };
  if (provider.model) out.model = provider.model;
  if (provider.reasoning_map) out.reasoning_map = provider.reasoning_map;
  return out;
}
