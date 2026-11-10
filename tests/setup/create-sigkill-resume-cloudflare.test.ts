import { describe, it } from 'bun:test';
import { installCreateSigkillResume, resumeCreateAfterSigkill } from './fixtures/create-sigkill-resume.js';

describe('cloudflare create journeys across SIGKILL', () => {
  const dirs = { root: '', project: '' };
  installCreateSigkillResume(dirs);
  for (const boundary of ['cloudflare-login', 'partial-create', 'installed']) {
    it(`cloudflare: resumes after SIGKILL at ${boundary}`, async () => {
      await resumeCreateAfterSigkill('cloudflare', boundary, dirs.root, dirs.project);
    }, 90_000);
  }
});
