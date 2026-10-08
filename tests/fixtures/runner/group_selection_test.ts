import { expect, it } from 'bun:test';

it('does not pass the outer runner group selector to test processes', () => {
  expect(process.env.MYCO_TEST_GROUP).toBeUndefined();
});
