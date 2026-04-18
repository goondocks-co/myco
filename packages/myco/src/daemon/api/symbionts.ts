import { loadManifests } from '@myco/symbionts/detect.js';
import { loadMergedConfig, getEnabledSymbiontNames } from '../../config/loader.js';
import type { RouteResponse } from '../router.js';
import { detectSymbiontInjectionSupport } from '@myco/symbionts/injection-support.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public manifest fields exposed via the API (no internal hook config). */
export interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  enabled: boolean;
  resumeCommand?: string;
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function listSymbiontInfos(vaultDir: string): SymbiontInfo[] {
  const manifests = loadManifests();

  let enabledNames: Set<string> | null = null;
  try {
    enabledNames = getEnabledSymbiontNames(loadMergedConfig(vaultDir));
  } catch { /* config not loadable */ }

  return manifests.map((manifest) => ({
    name: manifest.name,
    displayName: manifest.displayName,
    binary: manifest.binary,
    enabled: enabledNames ? enabledNames.has(manifest.name) : true,
    ...(manifest.resumeCommand ? { resumeCommand: manifest.resumeCommand } : {}),
    ...detectSymbiontInjectionSupport(manifest),
  }));
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
  return { body: { symbionts: listSymbiontInfos(vaultDir) } };
}
