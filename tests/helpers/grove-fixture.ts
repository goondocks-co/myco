/**
 * Re-exports the multi-Grove fixture helper for use by tests outside
 * `packages/myco/src/`. The canonical implementation lives in
 * `packages/myco/src/test-utils/grove-fixture.ts`.
 */
export {
  withMultiGroveFixture,
} from '@myco/test-utils/grove-fixture.js';

export type {
  FixtureProjectInput,
  FixtureGroveInput,
  FixtureMachineInput,
  FixtureProjectHandle,
  FixtureGroveHandle,
  FixtureMachineHandle,
} from '@myco/test-utils/grove-fixture.js';
