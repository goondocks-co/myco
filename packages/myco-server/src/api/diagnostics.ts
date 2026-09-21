/**
 * The Deployment's diagnostics, as one downloadable document.
 *
 * A member holds its own half and this holds the Deployment's; laid side by side
 * they explain an ordinary failure. The document is served to an owner and
 * nowhere else, and it is built by `core/diagnostics.ts` from the producers the
 * Status page already reads. Live membership admission requires a readable
 * database; only failures after admission can produce a partial document.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { deploymentDiagnostics } from '../core/diagnostics.js';

/** The filename a browser saves, stamped so two downloads do not overwrite each other. */
function filenameFor(now: number): string {
  return `myco-diagnostics-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
}

export async function handleDiagnostics(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const document = await deploymentDiagnostics(env, ctx.now);
  return new Response(JSON.stringify(document, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filenameFor(ctx.now)}"`,
      'cache-control': 'no-store',
    },
  });
}
