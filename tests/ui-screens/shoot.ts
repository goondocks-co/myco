/**
 * Before-and-after screenshots of a real deployment, for an owner's sign-off.
 *
 *   MYCO_SHOTS_URL=https://… MYCO_SHOTS_COOKIE='__Host-myco_session=…' \
 *     npm run screens:shoot -- <label> /path [/path …]
 *
 * Each path is shot at 1280×820, 768×1024 and 390×844, dark and light, into
 * `target/ui-screens/shots/<label>/<page>-<viewport>-<mode>.png`, where the
 * page name is the path with its slashes turned into dashes. The cookie is read
 * from the environment only and is never written anywhere.
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { SHOTS_DIR, SHOT_MATRIX, openPage, shoot } from './checks.ts';
import { SCREENS_ENV } from './env.ts';

function pageName(route: string): string {
  const name = route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return name === '' ? 'home' : name;
}

async function main(argv: string[]): Promise<void> {
  const [label, ...routes] = argv;
  const url = process.env.MYCO_SHOTS_URL;
  const cookie = process.env.MYCO_SHOTS_COOKIE;
  if (!url || !cookie) throw new Error('set MYCO_SHOTS_URL and MYCO_SHOTS_COOKIE');
  if (!label || routes.length === 0) throw new Error('usage: shoot.ts <label> /path [/path …]');
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('the label is one path segment: letters, digits, dot, dash, underscore');
  process.env[SCREENS_ENV.url] = url.replace(/\/$/, '');

  const dir = path.join(SHOTS_DIR, label);
  const browser = await chromium.launch();
  try {
    for (const route of routes) {
      for (const { viewport, mode } of SHOT_MATRIX) {
        const { context, page } = await openPage(browser, { path: route, viewport, mode, cookie });
        try {
          await page.waitForLoadState('networkidle');
          process.stdout.write(`${await shoot(page, pageName(route), viewport, mode, dir)}\n`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
