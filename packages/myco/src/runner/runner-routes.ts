/**
 * The Deployment's runner-authenticated routes a runner calls outside its claim loop: the contact read and the
 * credential rotation. Both present the runner's own bearer on the Deployment-scoped headers a worker sends, name
 * no Project, and are classified by the member classifier.
 */
import { runnerRequest, RUNNER_REQUEST_TIMEOUT_MS } from './request.js';
import { classifyEventAnswer, ServerClient, type FetchLike, type Outcome } from '../member/transport.js';
import type { RunnerUpdateContact } from './update.js';

export const RUNNER_CONTACT_PATH = '/runners/contact';
export const RUNNER_ROTATE_PATH = '/runners/rotate';
const JSON_CONTENT_TYPE = 'application/json';

/** What a runner tells the Deployment about itself on contact. Reported only; it authenticates nothing. */
export interface RunnerMetadata {
  machineId?: string;
  os?: string;
  version?: string;
  update?: RunnerUpdateContact;
}

/** The runner and credential a contact answer names. */
export interface RunnerContact {
  runner: { id: string; name: string; deploymentId: string };
  credential: { id: string; expiresAt: number; refreshAfter: number };
}

/** Send one runner route request under `token`, and classify the answer. */
export async function postRunnerRoute(serverUrl: string, token: string, path: string, body: unknown, fetchImpl: FetchLike = globalThis.fetch, signal?: AbortSignal): Promise<Outcome> {
  const client = new ServerClient({ serverUrl, token }, fetchImpl);
  try {
    const raw = await runnerRequest(bounded => client.request('POST', path, {
      body: JSON.stringify(body), headers: { 'content-type': JSON_CONTENT_TYPE },
      budget: { signal: bounded, connectTimeoutMs: RUNNER_REQUEST_TIMEOUT_MS, requestTimeoutMs: RUNNER_REQUEST_TIMEOUT_MS }, scope: 'deployment',
    }), signal);
    return classifyEventAnswer(raw);
  } catch (error) {
    return classifyEventAnswer({ kind: 'transport', detail: error instanceof Error ? error.message : String(error) });
  }
}

/** Read a contact answer's runner and credential, or null where the body is not that shape. */
export function parseContact(body: Record<string, unknown>): RunnerContact | null {
  const runner = body.runner as Record<string, unknown> | null | undefined;
  const credential = body.credential as Record<string, unknown> | null | undefined;
  if (runner == null || credential == null) return null;
  if (typeof runner.id !== 'string' || typeof runner.name !== 'string' || typeof runner.deploymentId !== 'string') return null;
  if (typeof credential.id !== 'string' || typeof credential.expiresAt !== 'number' || typeof credential.refreshAfter !== 'number') return null;
  return {
    runner: { id: runner.id, name: runner.name, deploymentId: runner.deploymentId },
    credential: { id: credential.id, expiresAt: credential.expiresAt, refreshAfter: credential.refreshAfter },
  };
}

/** Contact the Deployment as the runner holding `token`. */
export function contactRunner(serverUrl: string, token: string, metadata: RunnerMetadata, fetchImpl?: FetchLike): Promise<Outcome> {
  return postRunnerRoute(serverUrl, token, RUNNER_CONTACT_PATH, metadata, fetchImpl);
}
