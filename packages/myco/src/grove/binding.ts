import {
  loadProjectManifest,
  type ProjectManifest,
} from '../config/project-manifest.js';
import { loadGroveRecord } from './registry.js';
import { pathsEquivalent, resolveMycoHome, resolveProjectVaultDir } from './paths.js';
import { ProjectVault } from '../vault/project-vault.js';
import {
  activationMarkerPath,
  readActivationMarker,
  type ActivationMarker,
} from './activation.js';
import {
  findRegisteredProject,
  registerProjectInGrove,
  type ResolvedRegisteredProject,
} from './registry.js';
import { resolveProjectRoot } from '../vault/resolve.js';

/**
 * Single source of truth for a project's Grove binding state.
 *
 * A grove-bound project is a TRIPLE invariant: `project.toml` carries a
 * `grove.binding_id`, `.myco/migration/grove-activation.json` records the
 * activation, and `~/.myco/groves/<id>/registry/projects.toml` holds the
 * registry row. Pre-Grove vaults have none of the three. The combinations
 * in between are the bug class we keep getting bitten by — every code
 * path that branches on grove-vs-legacy must consult this helper rather
 * than checking one leg in isolation.
 */
export type GroveBindingResult =
  | { kind: 'grove'; manifest: ProjectManifest; marker: ActivationMarker; registered: ResolvedRegisteredProject }
  | { kind: 'legacy' }
  | { kind: 'inconsistent'; details: BindingInconsistency };

export interface BindingInconsistency {
  /** Free-form reason; suitable for log lines and error messages. */
  reason: string;
  /** Which legs are present, for repair logic. */
  hasManifest: boolean;
  hasMarker: boolean;
  hasRegistryRow: boolean;
  /** Concrete pointer to where the data is/should be. */
  vaultDir: string;
  projectRoot: string;
}

export interface ResolveProjectGroveBindingOptions {
  mycoHome?: string;
  /**
   * When true, attempt to repair a recoverable inconsistency in place:
   *   - manifest missing but marker + registry present → rewrite project.toml
   *   - registry row missing but manifest + marker present → re-register
   * The result is then re-resolved. Returns the post-repair result.
   * Disabled by default so read-only callers stay read-only.
   */
  repair?: boolean;
}

export function resolveProjectGroveBinding(
  vaultDir: string,
  options: ResolveProjectGroveBindingOptions = {},
): GroveBindingResult {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const projectRoot = resolveProjectRoot(vaultDir);

  const manifest = loadProjectManifest(vaultDir);
  const markerPath = activationMarkerPath(vaultDir);
  const marker = safeReadMarker(markerPath);
  const hasManifest = Boolean(manifest);
  const hasMarker = Boolean(marker);

  // Pre-Grove vault: no manifest, no marker, no migration ever happened.
  if (!hasManifest && !hasMarker) return { kind: 'legacy' };

  // Manifest present but no binding → in-progress init or partial write.
  if (manifest && !manifest.grove?.binding_id && !hasMarker) {
    return {
      kind: 'inconsistent',
      details: {
        reason: 'project.toml is present but carries no grove.binding_id and no activation marker exists',
        hasManifest,
        hasMarker,
        hasRegistryRow: false,
        vaultDir,
        projectRoot,
      },
    };
  }

  // We have at least one of {manifest with binding, marker}. Resolve registry.
  const registeredFromManifest = manifest?.grove?.binding_id
    ? findRegisteredProject({
        projectId: manifest.project.id,
        bindingId: manifest.grove.binding_id,
      }, mycoHome)
    : null;
  const registeredFromMarker = !registeredFromManifest && marker
    ? findRegisteredProject({
        projectId: marker.project_id,
        bindingId: marker.grove_binding_id,
        groveId: marker.grove_id,
      }, mycoHome)
    : null;
  const registered = registeredFromManifest ?? registeredFromMarker;

  // Auto-repair pass: if manifest or registry leg is missing but the
  // other two are consistent, rewrite the missing leg from authoritative
  // state. Repair is opt-in so read-only callers don't cause writes.
  if (options.repair) {
    return resolveAfterRepair(vaultDir, projectRoot, manifest, marker, registered, mycoHome);
  }

  // Triple invariant: all three present and consistent.
  if (manifest?.grove?.binding_id && marker && registered) {
    if (
      manifest.grove.binding_id === marker.grove_binding_id
      && manifest.project.id === marker.project_id
      && registered.project.binding_id === manifest.grove.binding_id
    ) {
      return { kind: 'grove', manifest, marker, registered };
    }
    return {
      kind: 'inconsistent',
      details: {
        reason: 'project.toml, marker, and registry row disagree on project_id or binding_id',
        hasManifest: true,
        hasMarker: true,
        hasRegistryRow: true,
        vaultDir,
        projectRoot,
      },
    };
  }

  // Missing one of the three legs — surface what's broken.
  return {
    kind: 'inconsistent',
    details: {
      reason: missingLegReason(manifest, marker, registered),
      hasManifest,
      hasMarker,
      hasRegistryRow: Boolean(registered),
      vaultDir,
      projectRoot,
    },
  };
}

function missingLegReason(
  manifest: ProjectManifest | null,
  marker: ActivationMarker | null,
  registered: ResolvedRegisteredProject | null,
): string {
  const missing: string[] = [];
  if (!manifest?.grove?.binding_id) missing.push('project.toml grove binding');
  if (!marker) missing.push('activation marker');
  if (!registered) missing.push('grove registry row');
  return `Grove binding is incomplete — missing: ${missing.join(', ')}`;
}

function resolveAfterRepair(
  vaultDir: string,
  projectRoot: string,
  manifest: ProjectManifest | null,
  marker: ActivationMarker | null,
  registered: ResolvedRegisteredProject | null,
  mycoHome: string,
): GroveBindingResult {
  let nextManifest = manifest;
  let nextRegistered = registered;

  // Repair 1: marker + registry exist, manifest is missing → recreate from marker.
  if (!nextManifest && marker && nextRegistered) {
    const groveRecord = loadGroveRecord(marker.grove_id, mycoHome);
    const restored: ProjectManifest = {
      project: { id: marker.project_id, name: marker.project_name },
      grove: {
        mode: 'local',
        id: marker.grove_id,
        slug: marker.grove_slug,
        ...(groveRecord ? { name: groveRecord.name } : {}),
      },
    };
    // Repair path: write both the portable manifest and the per-machine
    // binding atomically via ProjectVault. Preserves the marker's
    // existing binding_id (do NOT mint a new one — the marker's id is
    // the canonical record we're recovering from).
    new ProjectVault(resolveProjectRoot(vaultDir)).writeIdentity({
      manifest: restored,
      localManifest: {
        grove_binding: { binding_id: marker.grove_binding_id, mode: 'local' },
      },
    });
    nextManifest = {
      ...restored,
      grove: { ...restored.grove, mode: 'local', binding_id: marker.grove_binding_id },
    };
  }

  // Repair 2: manifest + marker exist, registry row missing → re-register.
  if (nextManifest?.grove?.binding_id && marker && !nextRegistered) {
    registerProjectInGrove(marker.grove_id, {
      projectId: marker.project_id,
      projectName: marker.project_name,
      projectRoot,
      bindingId: marker.grove_binding_id,
    }, mycoHome);
    nextRegistered = findRegisteredProject({
      projectId: marker.project_id,
      bindingId: marker.grove_binding_id,
      groveId: marker.grove_id,
    }, mycoHome);
  }

  // Re-evaluate without the repair flag so the consistency check runs.
  if (nextManifest?.grove?.binding_id && marker && nextRegistered) {
    if (
      nextManifest.grove.binding_id === marker.grove_binding_id
      && nextManifest.project.id === marker.project_id
      && nextRegistered.project.binding_id === nextManifest.grove.binding_id
    ) {
      return { kind: 'grove', manifest: nextManifest, marker, registered: nextRegistered };
    }
  }

  // Pre-Grove vault: nothing to repair.
  if (!nextManifest && !marker) return { kind: 'legacy' };

  return {
    kind: 'inconsistent',
    details: {
      reason: missingLegReason(nextManifest, marker, nextRegistered),
      hasManifest: Boolean(nextManifest),
      hasMarker: Boolean(marker),
      hasRegistryRow: Boolean(nextRegistered),
      vaultDir,
      projectRoot,
    },
  };
}

function safeReadMarker(markerPath: string): ActivationMarker | null {
  try {
    return readActivationMarker(markerPath);
  } catch {
    return null;
  }
}

/** Convenience: which vault dir the helper would consult for a given project root. */
export function vaultDirForProjectRoot(projectRoot: string): string {
  return resolveProjectVaultDir(projectRoot);
}
