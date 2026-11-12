import { test } from 'bun:test';
import { resumedVectorPage, unverifiedVectorPage, vectorPageBreakages } from './embedding-vector-page-fixture.js';

test('a page that does not verify leaves every row holding its bytes, and is released once it cannot be in flight', () => unverifiedVectorPage('native'), 60_000);

for (const [fault, breakPage] of vectorPageBreakages) {
  test(`a page that is ${fault} answers a retryable outcome, changes nothing, and resumes exactly once it returns`, () => resumedVectorPage('native', breakPage), 120_000);
}
