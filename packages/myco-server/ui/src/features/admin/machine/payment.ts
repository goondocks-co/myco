/**
 * How a runner pays for the agent it uses for Myco's work: the agent the server chose for it today, the payer set on
 * it for that agent, and whether it could use that agent, from the runner's own report. A runner that is not online
 * is told as of when it was last seen.
 */
import { runnerAgentLoginReady, runnerFallbackWords, storedKeyFailureTitle, type RunnerCredentialChoice, type RunnerFallbackNotice, type RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import type { AgentPayersAnswer } from '../../../hooks/use-fleet';
import { harnessLabel } from '../../../lib/harness';

export type PaymentRunner = Pick<RunnerFleetRecord, 'id' | 'offers' | 'credentialChoices' | 'storedKeyFailures' | 'fallbackNotices' | 'connected'>;

/** What the server says of a runner's payment, or why it can't say. */
export type Payment =
  | { state: 'unknown' }
  | { state: 'no-agent' }
  | {
    state: 'set';
    agent: string;
    /** Null when the stored choice is one this server can no longer use and needs choosing again. */
    choice: RunnerCredentialChoice | null;
    fallback: RunnerFallbackNotice | undefined;
    /** Whether it could use the agent with that payer, as of its last report; null when it did not report. */
    ready: boolean | null;
    /** Why it couldn't, when it couldn't. */
    why: string | null;
  };

export function paymentOf(runner: PaymentRunner, payers: AgentPayersAnswer | undefined, storedUsable: Readonly<Record<string, boolean>> | undefined): Payment {
  const today = payers?.today.find((entry) => entry.id === runner.id);
  if (today === undefined) return { state: 'unknown' };
  const agent = today.agent;
  if (agent === null) return { state: 'no-agent' };
  const label = harnessLabel(agent);
  const choices = runner.credentialChoices ?? {};
  const choice = Object.hasOwn(choices, agent) ? choices[agent]! : 'own';
  const fallback = runner.fallbackNotices?.find((entry) => entry.agent === agent);
  const offer = runner.offers?.find((entry) => entry.id === agent);
  if (runner.offers === null) return { state: 'set', agent, choice, fallback, ready: null, why: null };
  if (offer === undefined) return { state: 'set', agent, choice, fallback, ready: false, why: `${label} is not on it` };
  if (runnerAgentLoginReady(offer, runner.credentialChoices, storedUsable)) return { state: 'set', agent, choice, fallback, ready: true, why: null };
  const failure = runner.storedKeyFailures?.find((entry) => entry.agent === agent);
  const why = choice !== 'own'
    ? (failure !== undefined ? storedKeyFailureTitle(failure.failure, failure.slot) : 'There is no stored key it can use')
    : offer.installed === false ? `${label} is not installed` : `It is not signed in to ${label}`;
  return { state: 'set', agent, choice, fallback, ready: false, why };
}

/** Who pays for an agent, as a phrase after "paid by". */
export const PAYER_PHRASES: Readonly<Record<RunnerCredentialChoice, string>> = {
  own: 'its own sign-in',
  stored: 'the stored key',
  'stored-first': 'the stored key first, then its own sign-in',
};

/** Whether it can use the agent: now while online, else as of when it was last seen. */
function readyWords(payment: Extract<Payment, { state: 'set' }>, connected: boolean): string {
  const label = harnessLabel(payment.agent);
  if (payment.ready === null) return `whether it can use ${label} is unknown`;
  if (payment.ready) return connected ? 'and can use it now' : 'and could use it when last seen';
  return `but ${connected ? 'can’t use it now' : 'couldn’t use it when last seen'}. ${payment.why}`;
}

/** How a runner is set to pay for the agent it uses for learning, and whether it can use it, in one sentence. */
export function payWords(runner: PaymentRunner, payers: AgentPayersAnswer | undefined, storedUsable: Readonly<Record<string, boolean>> | undefined): string {
  const payment = paymentOf(runner, payers, storedUsable);
  if (payment.state === 'unknown') return 'Which agent it would use, and how it pays, is unknown right now';
  if (payment.state === 'no-agent') return 'No agent on it can do this work now';
  const label = harnessLabel(payment.agent);
  const set = payment.choice === null ? `Who pays for ${label} needs choosing again` : `Set to pay for ${label} with ${PAYER_PHRASES[payment.choice]}`;
  if (payment.fallback !== undefined) return `${set}. ${runnerFallbackWords(payment.fallback.reason, payment.fallback.slot)}`;
  if (payment.ready === null) return `${set}; ${readyWords(payment, runner.connected)}`;
  return payment.ready ? `${set}, ${readyWords(payment, runner.connected)}` : `${set}, ${readyWords(payment, runner.connected)}.`;
}
