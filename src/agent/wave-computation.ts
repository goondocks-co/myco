/**
 * Wave computation for phased task execution.
 *
 * Uses Kahn's algorithm to topologically sort phases into dependency waves.
 * Phases in the same wave have no dependencies on each other and can
 * execute in parallel via Promise.allSettled().
 *
 * Also provides deterministic session ID generation for phases.
 */

import crypto from 'node:crypto';
import type { PhaseDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Wave computation (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute execution waves from phase dependency graph.
 *
 * Uses Kahn's algorithm to topologically sort phases into waves.
 * Phases in the same wave have no dependencies on each other and
 * can execute in parallel via Promise.allSettled().
 *
 * @throws Error if circular dependencies are detected.
 */
export function computeWaves(phases: PhaseDefinition[]): PhaseDefinition[][] {
  const nameToPhase = new Map(phases.map(p => [p.name, p]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dependency → phases that depend on it

  // Initialize
  for (const phase of phases) {
    inDegree.set(phase.name, 0);
    dependents.set(phase.name, []);
  }

  // Build adjacency — skip dependencies on phases not in the set
  // (they may have been removed by orchestrator directives)
  for (const phase of phases) {
    const deps = phase.dependsOn ?? [];
    for (const dep of deps) {
      if (!nameToPhase.has(dep)) continue; // skipped/removed phase — treat as satisfied
      inDegree.set(phase.name, (inDegree.get(phase.name) ?? 0) + 1);
      dependents.get(dep)!.push(phase.name);
    }
  }

  // Collect waves
  const waves: PhaseDefinition[][] = [];
  const completed = new Set<string>();

  while (completed.size < phases.length) {
    // Find all phases with zero unsatisfied deps
    const wave: PhaseDefinition[] = [];
    for (const phase of phases) {
      if (completed.has(phase.name)) continue;
      if ((inDegree.get(phase.name) ?? 0) === 0) {
        wave.push(phase);
      }
    }

    if (wave.length === 0) {
      const remaining = phases.filter(p => !completed.has(p.name)).map(p => p.name);
      throw new Error(`Circular dependency detected among phases: ${remaining.join(', ')}`);
    }

    waves.push(wave);

    // Mark wave as completed and decrement dependents' in-degrees
    for (const phase of wave) {
      completed.add(phase.name);
      for (const dependent of (dependents.get(phase.name) ?? [])) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      }
    }
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic session ID (UUID format) for a phase.
 * Derived from run ID + phase name so the same run always produces
 * the same session IDs.
 */
export function phaseSessionId(runId: string, phaseName: string): string {
  const hash = crypto.createHash('sha256').update(`${runId}-${phaseName}`).digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}
