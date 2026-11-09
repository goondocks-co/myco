import { createRequire } from 'node:module';

/**
 * Resends a Miniflare bridge request that workerd's keep-alive close dropped before it was read.
 *
 * workerd closes a kept-alive connection 5 seconds after its last response. Bun's fetch sends a GET again when a
 * reused connection closes under it and fails a POST, and Miniflare's proxy speaks POST, so a statement that reaches
 * a parked connection as workerd closes it fails with "The socket connection was closed unexpectedly". Miniflare's
 * synchronous calls leave a connection parked between them and each runs in an eval Worker, where test preloads do
 * not run, so the Worker's script is given the resend as it starts.
 *
 * A close later than `RESEND_WITHIN_MS` after the request was sent is left to fail: workerd was working on it.
 */

const load = createRequire(import.meta.url);

type WorkerOptions = { eval?: boolean } & Record<string, unknown>;
type WorkerConstructor = new (script: unknown, options?: WorkerOptions) => object;

/** Source text found only in Miniflare's synchronous bridge script. */
const BRIDGE_SCRIPT_MARKER = 'actualRequire("undici")';
const RESEND_WITHIN_MS = 500;
/** Printed to the job's output for every resend, so a run shows how often workerd's close was hit. */
export const RESEND_LOG_PREFIX = '[miniflare-bridge] resent a request after workerd closed its kept-alive connection';

const BRIDGE_SCRIPT_PRELUDE = [
  '{const undici=require("undici");const send=undici.fetch;undici.fetch=async(input,init)=>{',
  'const sentAt=Date.now();try{return await send(input,init);}catch(error){',
  `if(String(error&&error.message).includes("The socket connection was closed unexpectedly")&&Date.now()-sentAt<=${RESEND_WITHIN_MS}){`,
  `console.error(${JSON.stringify(RESEND_LOG_PREFIX)});return send(input,init);}`,
  'throw error;}};}\n',
].join('');

/** The script a Worker runs: Miniflare's bridge starts with the resend installed, any other script is unchanged. */
export function workerScriptResendingStaleRequests(script: unknown, options?: WorkerOptions): unknown {
  if (options?.eval !== true || typeof script !== 'string' || !script.includes(BRIDGE_SCRIPT_MARKER)) return script;
  return BRIDGE_SCRIPT_PRELUDE + script;
}

/** Applies the resend to every Miniflare started in this process. */
export function installStaleConnectionResend(): void {
  const threads = load('node:worker_threads') as { Worker: WorkerConstructor };
  const OriginalWorker = threads.Worker;
  threads.Worker = class extends OriginalWorker {
    constructor(script: unknown, options?: WorkerOptions) {
      super(workerScriptResendingStaleRequests(script, options), options);
    }
  };
}
