import { loadManifests } from '@myco/symbionts/detect.js';
import type { RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public manifest fields exposed via the API (no internal hook config). */
interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  resumeCommand?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * List all registered symbiont manifests.
 *
 * Returns the public-facing subset of each manifest — enough for the UI
 * to build resume commands, display agent names, etc.
 */
export async function handleListSymbionts(): Promise<RouteResponse> {
  const manifests = loadManifests();

  const symbionts: SymbiontInfo[] = manifests.map((m) => ({
    name: m.name,
    displayName: m.displayName,
    binary: m.binary,
    ...(m.resumeCommand ? { resumeCommand: m.resumeCommand } : {}),
  }));

  return { body: { symbionts } };
}
