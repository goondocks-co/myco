import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps direct and indirect pause readers confined to historical upgrade admission', () => {
  const historicalAdmission = new Set(['db/schema-v102.ts', 'db/schema-v104.ts', 'db/schema-v110.ts', 'db/schema-v695.ts',
    'db/thin-learning-admission.ts', 'platform/bun/private-recovery-copy.ts'].map(file => join('packages/myco-server/src', file)));
  const readers = ['packages/myco-server/src', 'packages/myco-server/ui/src', 'packages/myco/src'].flatMap(root =>
    readdirSync(root, { recursive: true }).map(String)
      .filter(file => /\.tsx?$/.test(file) && !/\.generated\./.test(file))
      .map(file => join(root, file)))
    .filter(file => !historicalAdmission.has(file))
    .filter(file => /learning_paused|learning_resumed_at|dispatchedBeforeResume|\bTHIN_LEARNING_ADMISSION_SQL\b|\badmitThinLearningRemoval\b/.test(readFileSync(file, 'utf8')));
  expect(readers).toEqual([]);
});
