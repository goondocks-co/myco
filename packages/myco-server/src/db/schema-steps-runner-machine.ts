import { NEXT_RUNNER_MACHINE } from './schema-vNEXT-runner-machine.js';
import { changing, type SchemaStep } from './schema-step.js';

/**
 * The machine a runner registration was approved for: the id its device request carried, bound when the registration
 * commits and changed only by an approved replacement. Existing registrations take it from the approved decision
 * audit, which holds it for every request approved since that audit began.
 */
export const RUNNER_MACHINE_STEPS: readonly SchemaStep[] = [{
  version: NEXT_RUNNER_MACHINE,
  statements: [
    'ALTER TABLE runners ADD COLUMN machine_id TEXT',
    `UPDATE runners SET machine_id = (SELECT a.machine_id FROM device_decision_audit a
      WHERE a.request_id = runners.registration_id AND a.subject = 'runner' AND a.decision = 'approved')
      WHERE machine_id IS NULL AND registration_id IS NOT NULL`,
  ],
  reaches: changing(['runners'], 'The machine id bound to each runner registration at approval, filled from the decision audit.'),
}];
