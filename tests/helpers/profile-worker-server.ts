import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';

/** A fake Deployment supporting execution profiles on its authenticated read. */
export function profileWorkerServer(send: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/members/status') return Response.json({ persisted: true }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
    return send(input, init);
  }) as typeof fetch;
}
