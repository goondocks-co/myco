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
 *
 * A refusal's reason is written for the run's page, which shows it after "The
 * agent couldn't use the chosen model:"; the values a session offers follow it in
 * parentheses, which the page leaves to the run's technical details.
 */
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { recordOf, stringOf } from './stream.js';

/** A session configuration option, as the protocol reports one. */
export type ConfigOption = Record<string, unknown>;

/** The client's call to the agent, answered with the agent's whole response. */
export type AgentCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * The session's options as the agent last announced them in its own updates
 * (`config_option_update`), counted so a caller can tell whether one arrived
 * after a given point.
 */
export interface AnnouncedOptions {
  count: number;
  options: ConfigOption[] | null;
}

/** The model and effort options, by the id or the category the protocol gives each. */
const MODEL = { id: 'model', category: 'model' } as const;
const EFFORT = { id: 'effort', category: 'thought_level' } as const;

export const optionsOf = (value: unknown): ConfigOption[] =>
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

/**
 * What applying the profile came to: the session's options once applied, and
 * whether the claimed effort went unapplied because the model offers no effort
 * setting; or why it could not be applied.
 */
export type Applied = { ok: true; configOptions: ConfigOption[]; effortUnapplied: boolean } | { ok: false; detail: string };

/**
 * Set one option to `value` where the session is not already on it and offers
 * it, and confirm the session then reports it. The options the session holds
 * after the set are its reply's, or, where the reply carries none, those the
 * agent announced after the set was sent; a set followed by neither cannot be
 * confirmed. `missing` says what a session reporting no such option means: a
 * refusal, or nothing to apply.
 */
async function setOption(
  call: AgentCall, announced: () => AnnouncedOptions, sessionId: string, options: ConfigOption[],
  kind: { id: string; category: string }, value: string, what: string, missing: 'refuse' | 'accept',
): Promise<{ ok: true; configOptions: ConfigOption[]; absent: boolean } | { ok: false; detail: string }> {
  const option = find(options, kind);
  if (option === undefined) {
    return missing === 'accept' ? { ok: true, configOptions: options, absent: true } : { ok: false, detail: `it reported no ${what} for the session` };
  }
  if (option.currentValue === value) return { ok: true, configOptions: options, absent: false };
  const values = offered(option);
  if (!values.includes(value)) return { ok: false, detail: `it offers no ${what} ${value}${what === 'effort' ? ' for this model' : ''} (it offers ${listed(values)})` };
  const before = announced().count;
  const answer = await call('session/set_config_option', { sessionId, configId: option.id, value });
  const error = recordOf(answer.error);
  if (error !== null) return { ok: false, detail: `it refused the ${what} ${value} (${stringOf(error.message) ?? 'no reason given'})` };
  const replied = optionsOf(recordOf(answer.result)?.configOptions);
  const after = announced();
  const next = replied.length > 0 ? replied : after.count > before ? after.options : null;
  if (next === null) return { ok: false, detail: `it reported no ${what} after being set to ${value}` };
  const now = find(next, kind)?.currentValue;
  return now === value ? { ok: true, configOptions: next, absent: false } : { ok: false, detail: `it kept the ${what} ${String(now ?? '(none)')} after being set to ${value}` };
}

/**
 * Put the session on the claimed model, then on the claimed effort among those
 * the options read after the model was set offer, and answer the session's
 * options as they stand. A model the session offers efforts for runs at the
 * claimed one or not at all; a model that offers none runs, with the effort
 * marked unapplied.
 */
export async function applyProfile(
  call: AgentCall, sessionId: string, configOptions: unknown, profile: ExecutionProfile,
  announced: () => AnnouncedOptions = () => ({ count: 0, options: null }),
): Promise<Applied> {
  const model = await setOption(call, announced, sessionId, optionsOf(configOptions), MODEL, profile.model, 'model', 'refuse');
  if (!model.ok) return model;
  if (profile.effort === null) return { ok: true, configOptions: model.configOptions, effortUnapplied: false };
  const effort = await setOption(call, announced, sessionId, model.configOptions, EFFORT, profile.effort, 'effort', 'accept');
  return effort.ok ? { ok: true, configOptions: effort.configOptions, effortUnapplied: effort.absent } : effort;
}
