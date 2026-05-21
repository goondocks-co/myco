import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { loadMergedConfig, getEnabledSymbiontNames } from '../../config/loader.js';
import type { RouteResponse } from '../router.js';
import { detectSymbiontInjectionSupport } from '@myco/symbionts/injection-support.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';

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
  /**
   * Whether the agent appears installed on this machine — manifest
   * `detectionDir` exists. The basis for global-config wiring.
   */
  detected: boolean;
  /**
   * Whether Myco's global config block is present in the agent's
   * user-global config file. True when the agent's
   * `globalHooksTarget` file contains a Myco hook entry.
   */
  globallyInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function listSymbiontInfos(vaultDir: string, groveId?: string | null): SymbiontInfo[] {
  const manifests = loadManifests();
  const pkgRoot = resolvePackageRoot();

  let enabledNames: Set<string> | null = null;
  try {
    enabledNames = getEnabledSymbiontNames(loadMergedConfig(vaultDir, { groveId: groveId ?? null }));
  } catch { /* config not loadable */ }

  return manifests.map((manifest) => {
    const detector = new SymbiontInstaller(
      manifest, '/', pkgRoot, false, undefined, null, 'global',
    );
    const detected = detector.isAvailableForScope();
    const globallyInstalled = detected && detector.isConfigured();
    return {
      name: manifest.name,
      displayName: manifest.displayName,
      binary: manifest.binary,
      enabled: enabledNames ? enabledNames.has(manifest.name) : true,
      detected,
      globallyInstalled,
      ...(manifest.resumeCommand ? { resumeCommand: manifest.resumeCommand } : {}),
      ...detectSymbiontInjectionSupport(manifest),
    };
  });
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
export async function handleListSymbionts(vaultDir: string, groveId?: string | null): Promise<RouteResponse> {
  return { body: { symbionts: listSymbiontInfos(vaultDir, groveId) } };
}

/**
 * Trigger an on-demand symbiont detection pass. Runs the same code path
 * as the PowerManager periodic tick — installs Myco's global config
 * into any newly-detected agent, emits notifications, returns per-
 * symbiont status.
 */
export async function handleDetectSymbionts(vaultDir: string, groveId?: string | null): Promise<RouteResponse> {
  const { runSymbiontDetection } = await import('../../cli/bootstrap.js');
  const results = runSymbiontDetection();
  return {
    body: {
      results,
      symbionts: listSymbiontInfos(vaultDir, groveId),
    },
  };
}
