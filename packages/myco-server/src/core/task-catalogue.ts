/**
 * What each retained intelligence task needs before it may run.
 *
 * The 1.4 vault carries a partial version of this inverted, as
 * `CapabilityDef.scheduledTasks` in `packages/myco/src/config/capabilities.ts`.
 * That field lists only SCHEDULED tasks and nothing reads it at runtime — it
 * groups the settings UI. Locally no agent task is refused on a capability at
 * all: capabilities gate features there, and a capture-only project is made by
 * `reseedCaptureOnly()` writing every master gate false at provision.
 *
 * A Deployment has no provisioning moment — a Project appears from a member's
 * first write — so admission has to be asked per run, and this is the table that
 * answers it. Two kinds of gate, and every retained task names one:
 *
 * - **A capability**, per Project, absent meaning not admitted.
 * - **A provider**, per Deployment, for the capture-driven tasks. A title and
 *   summary rides capture rather than an intelligence capability, and asks only
 *   whether there is a model to call — resolved task-first then default, as
 *   `hasConfiguredProvider` resolves it locally.
 */
import type { RunAdmissionGate } from './runs.js';

/** Every retained task, with the gate it runs behind. Canopy's tasks belong to the map task and are not here. */
export const TASK_ADMISSION: Readonly<Record<string, RunAdmissionGate>> = {
  'container-smoke': { kind: 'capability', capability: 'cortex' },
  'cortex-instructions': { kind: 'capability', capability: 'cortex' },
  'cortex-prompt-builder': { kind: 'capability', capability: 'cortex' },
  'digest-only': { kind: 'capability', capability: 'cortex' },

  'skill-survey': { kind: 'capability', capability: 'skills' },
  'skill-generate': { kind: 'capability', capability: 'skills' },
  'skill-evolve': { kind: 'capability', capability: 'skills' },

  'vault-evolve': { kind: 'capability', capability: 'vault_evolution' },
  'vault-seed': { kind: 'capability', capability: 'vault_evolution' },
  'supersession-sweep': { kind: 'capability', capability: 'vault_evolution' },
  'extract-only': { kind: 'capability', capability: 'vault_evolution' },
  'review-session': { kind: 'capability', capability: 'vault_evolution' },

  'title-summary': { kind: 'provider' },
};

export const RETAINED_TASKS = Object.keys(TASK_ADMISSION);

/** The gate a task runs behind, or null for a name this Deployment does not serve. */
export function admissionForTask(taskName: string): RunAdmissionGate | null {
  return TASK_ADMISSION[taskName] ?? null;
}
