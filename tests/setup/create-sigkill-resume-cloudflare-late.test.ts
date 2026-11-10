import { describe, it } from 'bun:test';
import { installCreateSigkillResume, resumeCreateAfterSigkill } from './fixtures/create-sigkill-resume.js';

describe('cloudflare create journeys across SIGKILL', () => {
  const dirs = { root: '', project: '' };
  installCreateSigkillResume(dirs);
  for (const boundary of ['project', 'cloudflare-login', 'partial-create', 'before-deploy', 'installed']) {
    it(`cloudflare: resumes after SIGKILL at ${boundary}`, async () => {
      await resumeCreateAfterSigkill('cloudflare', boundary, dirs.root, dirs.project);
    }, 90_000);
  }
});
