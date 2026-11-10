import { reaching, type Reach } from './schema-step.js';
import { legacyClassTriggers } from './schema-v106.js';

/** The legacy classification triggers write a class row only where it cannot violate a constraint, whatever conflict mode the firing statement runs under. */
export const V108_STATEMENTS: readonly string[] = legacyClassTriggers(true).flatMap((trigger) => [
  `DROP TRIGGER IF EXISTS ${/^CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(trigger)![1]}`,
  trigger,
]);

/** Why the step reaches tables earlier steps created. */
export const V108_REACHES: readonly Reach[] = [
  ...reaching(['prompt_batches', 'responses', 'tool_calls', 'plans'], 'The step replaces the trigger it drops. A parser row is classified as the legacy derivation in the statement that writes it. A change to a row\'s class evidence reclassifies it in the same statement.'),
  ...reaching(['tags'], 'The step replaces the trigger it drops. A tag edit is plan edit evidence and reclassifies the plan. A tag removal is plan edit evidence and reclassifies the plan.'),
];
