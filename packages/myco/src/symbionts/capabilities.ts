/**
 * Capability lookup helper.
 *
 * Capabilities live on each symbiont's YAML manifest under `capabilities.*`.
 * Default is `false` whenever the field is absent so adding a new capability
 * never silently activates it for an existing symbiont.
 */

import type { SymbiontCapabilities, SymbiontManifest } from './manifest-schema.js';
import { getManifestByName } from './detect.js';

/** Read a capability flag off a manifest. Missing field reads as `false`. */
export function manifestHasCapability(
  manifest: SymbiontManifest | undefined,
  capability: keyof SymbiontCapabilities,
): boolean {
  return manifest?.capabilities?.[capability] === true;
}

/**
 * Resolve a capability for a symbiont by name. Returns `false` for unknown
 * names so callers can use this as a one-line gate.
 */
export function symbiontHasCapability(
  name: string | undefined,
  capability: keyof SymbiontCapabilities,
): boolean {
  return manifestHasCapability(getManifestByName(name), capability);
}

/** Read the tenancy-capable tool transport off a manifest. Absent → 'mcp'. */
export function manifestToolTransport(
  manifest: SymbiontManifest | undefined,
): 'mcp' | 'cli' {
  return manifest?.capabilities?.toolTransport ?? 'mcp';
}

/** Resolve the tool transport for a symbiont by name. Unknown → 'mcp'. */
export function symbiontToolTransport(name: string | undefined): 'mcp' | 'cli' {
  return manifestToolTransport(getManifestByName(name));
}
