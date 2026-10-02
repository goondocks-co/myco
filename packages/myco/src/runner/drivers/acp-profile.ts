/**
 * The claimed model and effort, applied to an agent-protocol session and
 * confirmed from what the session reports before the run's prompt is sent.
 *
 * A session answers which model and effort it runs on as configuration options:
 * a `model` option and an `effort` option (category `thought_level`), each with
 * its current value and the values it offers. OpenCode sends that session model
 * with every prompt, ahead of anything the run's agent names, so the session's
 * current value is the model the run runs on (#1608). A model the session does
 * not report, or does not offer, is never run: the turn ends unprompted with the
 * profile unapplied rather than on the harness's own default.
 */
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { recordOf, stringOf } from './stream.js';

/** The code a run ends with when the harness cannot run the claimed model or effort. */
export const PROFILE_UNAPPLIED = 'profile_unapplied';

/** A session configuration option, as the protocol reports one. */
type ConfigOption = Record<string, unknown>;

/** The client's call to the agent, answered with the agent's whole response. */
export type AgentCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The model and effort options, by the id or the category the protocol gives each. */
const MODEL = { id: 'model', category: 'model' } as const;
const EFFORT = { id: 'effort', category: 'thought_level' } as const;

const optionsOf = (value: unknown): ConfigOption[] =>
  Array.isArray(value) ? value.map(recordOf).filter((option): option is ConfigOption => option !== null) : [];

const find = (options: readonly ConfigOption[], kind: { id: string; category: string }): ConfigOption | undefined =>
  options.find((option) => option.id === kind.id) ?? options.find((option) => option.category === kind.category);

/** Every value an option offers, its groups' included. */
function offered(option: ConfigOption): string[] {
  return optionsOf(option.options).flatMap((entry) =>
    Array.isArray(entry.options) ? optionsOf(entry.options).map((inner) => stringOf(inner.value)) : [stringOf(entry.value)],
  ).filter((value): value is string => value !== null);
}

/** How many offered values a refusal names before counting the rest. */
const NAMED_OFFERS = 8;

const listed = (values: readonly string[]): string => values.length === 0 ? 'none'
  : values.length <= NAMED_OFFERS ? values.join(', ') : `${values.slice(0, NAMED_OFFERS).join(', ')} and ${values.length - NAMED_OFFERS} more`;

/** What applying the profile came to: the session's options once applied, or why it could not be. */
export type Applied = { ok: true; configOptions: ConfigOption[] } | { ok: false; detail: string };

/**
 * Set one option to `value` where the session is not already on it and offers
 * it, and confirm the session then reports it. `missing` says what a session
 * reporting no such option means: a refusal, or nothing to apply.
 */
async function setOption(
  call: AgentCall, sessionId: string, options: ConfigOption[], kind: { id: string; category: string }, value: string, what: string,
  missing: 'refuse' | 'accept',
): Promise<Applied> {
  const option = find(options, kind);
  if (option === undefined) {
    return missing === 'accept' ? { ok: true, configOptions: options } : { ok: false, detail: `the harness reports no ${what} for its session, so the run's ${what} ${value} cannot be confirmed` };
  }
  if (option.currentValue === value) return { ok: true, configOptions: options };
  const values = offered(option);
  if (!values.includes(value)) return { ok: false, detail: `the harness offers no ${what} ${value} (it offers ${listed(values)})` };
  const answer = await call('session/set_config_option', { sessionId, configId: option.id, value });
  const error = recordOf(answer.error);
  if (error !== null) return { ok: false, detail: `the harness refused the ${what} ${value}: ${stringOf(error.message) ?? 'no reason given'}` };
  const reported = optionsOf(recordOf(answer.result)?.configOptions);
  const next = reported.length === 0 ? options : reported;
  const now = find(next, kind)?.currentValue;
  return now === value ? { ok: true, configOptions: next } : { ok: false, detail: `the harness kept the ${what} ${String(now ?? '(none)')} after being set to ${value}` };
}

/**
 * Put the session on the claimed model, then on the claimed effort, and answer
 * the session's options as they stand. A model the session offers efforts for
 * runs at the claimed one or not at all; a model that offers none takes no
 * effort, and runs.
 */
export async function applyProfile(call: AgentCall, sessionId: string, configOptions: unknown, profile: ExecutionProfile): Promise<Applied> {
  const model = await setOption(call, sessionId, optionsOf(configOptions), MODEL, profile.model, 'model', 'refuse');
  if (!model.ok || profile.effort === null) return model;
  return setOption(call, sessionId, model.configOptions, EFFORT, profile.effort, 'effort', 'accept');
}
