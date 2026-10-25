import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { readHarnessSessions } from '@myco/symbionts/harness-activity.js';
import { MemberSpool } from '@myco/member/spool.js';
import { deploymentUrl } from '@myco/member/registry.js';
import { listSpoolDestinationsResult } from '@myco/member/routing.js';

/** Native session identity is attributed only through the spool's immutable capture route. */
export function deploymentHarnessRanAt(manifest: SymbiontManifest, mycoHome: string, serverUrl: string, now: number): number | undefined {
  const routes = listSpoolDestinationsResult(mycoHome);
  if (routes.issues.length > 0) throw new Error('Session routing destinations are unavailable');
  const identities = new Map<string, string | null>();
  for (const route of routes.destinations) {
    const spool = new MemberSpool(route, { mycoHome, initialize: false, createReadLocks: false });
    for (const { sessionId, agent } of spool.readSessionRoutes()) {
      if (agent !== manifest.name) continue;
      const url = deploymentUrl(route.serverUrl);
      const previous = identities.get(sessionId);
      identities.set(sessionId, previous === undefined || previous === url ? url : null);
    }
  }
  let ranAt: number | undefined;
  for (const session of readHarnessSessions(manifest, mycoHome, now)) {
    if (identities.get(session.id) === deploymentUrl(serverUrl)) ranAt = Math.max(ranAt ?? 0, session.at);
  }
  return ranAt;
}
