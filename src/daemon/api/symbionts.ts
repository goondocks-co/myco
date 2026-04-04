import { loadManifests } from '@myco/symbionts/detect.js';
import { loadConfig } from '../../config/loader.js';
import type { RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public manifest fields exposed via the API (no internal hook config). */
interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  enabled: boolean;
  resumeCommand?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * List all registered symbiont manifests with their enabled state.
 *
 * Returns the public-facing subset of each manifest — enough for the UI
 * to build resume commands, display agent names, and show enabled state.
 * When the config lacks a `symbionts` section (pre-existing installs),
 * all manifests default to `enabled: true`.
 */
export async function handleListSymbionts(vaultDir: string): Promise<RouteResponse> {
  const manifests = loadManifests();

  let enabledNames: Set<string> | null = null;
  try {
    const config = loadConfig(vaultDir);
    if (config.symbionts) {
      enabledNames = new Set(
        Object.entries(config.symbionts)
          .filter(([, entry]) => entry.enabled)
          .map(([name]) => name),
      );
    }
  } catch { /* config not loadable */ }

  const symbionts: SymbiontInfo[] = manifests.map((m) => ({
    name: m.name,
    displayName: m.displayName,
    binary: m.binary,
    enabled: enabledNames ? enabledNames.has(m.name) : true,
    ...(m.resumeCommand ? { resumeCommand: m.resumeCommand } : {}),
  }));

  return { body: { symbionts } };
}
