/**
 * Every CLI process keeps its loopback dials off a configured proxy before it
 * does anything else: a renewal, a worker claim or a health probe to a
 * Deployment on this machine carries a bearer, and a proxy would see it in
 * clear. Admission adds any other loopback host it admits
 * (`member/server-url.ts`).
 */
import { bypassProxyFor } from '../member/server-url.js';

/** The loopback names this runtime's `NO_PROXY` matching needs spelled out: it takes exact hosts, never a CIDR block. */
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

/** Keep this process's loopback dials off any configured proxy. Run once at start, before anything dials. */
export function keepLoopbackOffProxy(env: NodeJS.ProcessEnv = process.env): void {
  bypassProxyFor(LOOPBACK_NAMES, env);
}
