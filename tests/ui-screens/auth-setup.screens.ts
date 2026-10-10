import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { baseUrl, setAppearance } from './checks';
import { dashboardMe } from '../helpers/dashboard-permissions';

const scenarios = [
  { name: 'device-unclaimed', url: '/device?code=BCDF-2345', state: 'unclaimed', words: 'myco server setup-owner' },
  { name: 'device-unlinked', url: '/device', state: 'unlinked', words: 'Ask an owner or admin' },
  { name: 'owner-link-expired', url: '/link#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', state: 'unclaimed', words: 'This owner link has expired' },
  { name: 'owner-link-missing', url: '/link', state: 'unclaimed', words: 'myco server setup-owner' },
  { name: 'member-link-missing', url: '/link', state: 'unlinked', words: 'Ask an admin of this server' },
  { name: 'not-a-member', url: '/projects', state: 'unlinked', words: 'Ask an owner or admin' },
  { name: 'owner-unclaimed', url: '/projects', state: 'unclaimed', words: 'myco server setup-owner' },
  { name: 'signed-out', url: '/projects', state: 'signed-out', words: 'Sign in with GitHub' },
  { name: 'sign-in-unconfigured', url: '/projects', state: 'unconfigured', words: 'myco server github-app' },
  { name: 'link-unconfigured', url: '/link#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', state: 'unconfigured', words: 'myco server github-app' },
  { name: 'projects-empty', url: '/projects', state: 'active', words: 'myco login' },
  { name: 'device-prefill', url: '/device?code=BCDF-2345', state: 'active', words: 'Check machine' },
] as const;

for (const mode of ['light', 'dark'] as const) {
  for (const scenario of scenarios) {
    test(`auth setup ${scenario.name} ${mode}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
      try {
        await setAppearance(context, mode);
        const page = await context.newPage();
        const origin = new URL(baseUrl()).origin;
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          if (url.pathname === '/auth/me') {
            if (scenario.state === 'unconfigured') return route.fulfill({ status: 503, json: { error: 'sign_in_unconfigured' } });
            if (scenario.state === 'signed-out') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
            return route.fulfill({ json: dashboardMe({ sub: '9001', login: 'octocat',
              member: scenario.state === 'active' ? { id: 'mem_screen', label: 'octocat', role: 'admin' } : null,
              membership: { state: scenario.state === 'active' ? 'active' : scenario.state, reason: null },
            }) });
          }
          if (url.pathname === '/auth/link') return route.fulfill({ status: 400, json: { error: 'owner_link_denied' } });
          if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
          return route.continue();
        });
        await page.goto(baseUrl() + scenario.url);
        await expect(page.getByText(scenario.words, { exact: false }).first()).toBeVisible();
        if (scenario.name === 'device-prefill') {
          await expect(page.getByLabel('Code from your terminal')).toHaveValue('BCDF-2345');
          await expect(page.getByText('Approve this machine')).toHaveCount(0);
        }
        if (scenario.state === 'unconfigured') await expect(page.getByText('Sign in with GitHub')).toHaveCount(0);
        if (scenario.name === 'owner-link-missing') await expect(page.getByText('Ask an admin of this server', { exact: false })).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('myco setup');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const out = path.resolve('tests/ui-screens/evidence/auth-setup');
        fs.mkdirSync(out, { recursive: true });
        await page.screenshot({ path: path.join(out, `${mode}-${scenario.name}.png`), fullPage: true });
      } finally { await context.close(); }
    });
  }
}
