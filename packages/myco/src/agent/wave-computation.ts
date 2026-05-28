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

/**
 * Validate that every phase's `gateOnPriorMetadata` references a phase
 * in an EARLIER wave than the gating phase. `priorPhaseResults` (which
 * the gate reads) is only populated by completed waves — a same-wave
 * or forward gate would silently fail at runtime, so we reject at
 * task-load time with a clear authoring error instead.
 *
 * Also rejects self-references and references to unknown phases.
 * Skipping these checks lets a typo or wave-graph mistake propagate
 * into production where it shows up as "every run skips this phase
 * mysteriously."
 *
 * Throws on the first violation. Run order matches `phases` so the
 * error message points at the offending phase, not an arbitrary one.
 */
export function validatePhaseGatesAgainstWaves(phases: PhaseDefinition[]): void {
  const gatingPhases = phases.filter((p) => p.gateOnPriorMetadata);
  if (gatingPhases.length === 0) return;

  // Compute wave index per phase so we can detect forward/same-wave gates.
  // Reuses computeWaves to honor whatever dependency graph the task has,
  // including any orchestrator-driven skip set the caller has already
  // applied (validator runs on the YAML-loaded shape — pre-orchestrator).
  const waves = computeWaves(phases);
  const waveIndex = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((p) => waveIndex.set(p.name, i)));
  const phaseNames = new Set(phases.map((p) => p.name));

  for (const phase of gatingPhases) {
    const gate = phase.gateOnPriorMetadata!;
    if (gate.phase === phase.name) {
      throw new Error(
        `Phase "${phase.name}" gateOnPriorMetadata.phase is itself; a phase cannot gate on its own metadata.`,
      );
    }
    if (!phaseNames.has(gate.phase)) {
      throw new Error(
        `Phase "${phase.name}" gateOnPriorMetadata.phase "${gate.phase}" is not a phase in this task. ` +
        `Known phases: ${[...phaseNames].join(', ')}.`,
      );
    }
    const upstreamWave = waveIndex.get(gate.phase);
    const gatingWave = waveIndex.get(phase.name);
    if (upstreamWave === undefined || gatingWave === undefined) {
      // Defensive — computeWaves should always assign both. If not, surface.
      throw new Error(
        `Phase "${phase.name}" or its gate target "${gate.phase}" could not be placed in a wave. ` +
        `Check the dependsOn graph.`,
      );
    }
    if (upstreamWave >= gatingWave) {
      throw new Error(
        `Phase "${phase.name}" (wave ${gatingWave}) gateOnPriorMetadata references "${gate.phase}" (wave ${upstreamWave}). ` +
        `The gate target must be in an earlier wave — priorPhaseResults only carries completed waves. ` +
        `Add the upstream phase to "${phase.name}"'s dependsOn (directly or transitively) to push it into an earlier wave.`,
      );
    }
  }
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
