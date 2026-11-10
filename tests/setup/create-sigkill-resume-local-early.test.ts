import { describe, it } from 'bun:test';
import { installCreateSigkillResume, resumeCreateAfterSigkill } from './fixtures/create-sigkill-resume.js';

describe('local create journeys across SIGKILL', () => {
  const dirs = { root: '', project: '' };
  installCreateSigkillResume(dirs);
  for (const boundary of ['create', 'conversion', 'signin', 'owner-mint']) {
    it(`local: resumes after SIGKILL at ${boundary}`, async () => {
      await resumeCreateAfterSigkill('local', boundary, dirs.root, dirs.project);
    }, 90_000);
  }
});
