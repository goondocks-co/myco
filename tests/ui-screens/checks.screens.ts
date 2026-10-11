import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { expectQuiet, watchPage } from './checks.ts';

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/pending') {
      return;
    }
    if (request.url === '/error') {
      response.writeHead(500).end('failed');
      return;
    }
    if (request.url === '/navigation') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
        <a href="/destination">Navigate</a>
        <script>
          const controller = new AbortController();
          void fetch('/pending', { signal: controller.signal }).catch(() => {});
          document.querySelector('a').addEventListener('click', (event) => {
            event.preventDefault();
            history.pushState({}, '', '/destination');
            controller.abort();
          });
        </script>
      `);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<a href="/destination">Navigate</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('watchPage excludes an in-flight request cancelled by main-frame navigation', async ({ page }) => {
  const watch = watchPage(page);
  const started = page.waitForRequest(`${origin}/pending`);
  await page.goto(`${origin}/navigation`);
  await started;
  const failed = page.waitForEvent('requestfailed', (request) => request.url() === `${origin}/pending`);
  await page.getByRole('link', { name: 'Navigate' }).click();
  await expect(page).toHaveURL(`${origin}/destination`);
  expect((await failed).failure()?.errorText).toBe('net::ERR_ABORTED');
  expectQuiet(watch);
});

test('watchPage reports ERR_ABORTED without a later navigation', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.route('**/aborted', (route) => route.abort('aborted'));
  const failed = page.waitForEvent('requestfailed');
  await page.evaluate(() => fetch('/aborted').catch(() => undefined));
  expect((await failed).failure()?.errorText).toBe('net::ERR_ABORTED');
  expect(watch.failedRequests).toEqual([`GET ${origin}/aborted: net::ERR_ABORTED`]);
  expect(() => expectQuiet(watch)).toThrow();
});

test('watchPage reports a 500 response', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.evaluate(() => fetch('/error'));
  expect(watch.failedRequests).toEqual([`GET ${origin}/error: 500`]);
  expect(() => expectQuiet(watch)).toThrow();
});
