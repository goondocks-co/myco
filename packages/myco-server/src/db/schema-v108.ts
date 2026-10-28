import { legacyClassTriggers } from './schema-v106.js';

/** The legacy classification triggers write a class row only where it cannot violate a constraint, whatever conflict mode the firing statement runs under. */
export const V108_STATEMENTS: readonly string[] = legacyClassTriggers(true).flatMap((trigger) => [
  `DROP TRIGGER IF EXISTS ${/^CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(trigger)![1]}`,
  trigger,
]);
