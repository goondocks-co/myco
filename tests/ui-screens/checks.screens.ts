import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { expectQuiet, watchPage } from './checks.ts';

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith('/pending')) {
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
    if (request.url === '/spa-navigation') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
        <a href="/destination">Navigate</a>
        <script>
          const controllers = ['runs', 'spores', 'sessions'].map((resource) => {
            const controller = new AbortController();
            void fetch('/pending?resource=' + resource, { signal: controller.signal }).catch(() => {});
            return controller;
          });
          document.querySelector('a').addEventListener('click', async (event) => {
            event.preventDefault();
            controllers.forEach((controller) => controller.abort());
            await window.abortsObserved();
            history.pushState({}, '', '/destination');
          });
        </script>
      `);
      return;
    }
    if (request.url === '/document-navigation') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
        <a href="/destination">Navigate</a>
        <script>
          const controller = new AbortController();
          void fetch('/pending', { signal: controller.signal }).catch(() => {});
          window.addEventListener('pagehide', () => controller.abort());
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

for (const loadInAction of [false, true]) test(`watchPage stays quiet when SPA aborts precede the navigation action commit${loadInAction ? ' after a document load in that action' : ''}`, async ({ page }) => {
  const watch = watchPage(page);
  const resources = ['runs', 'spores', 'sessions'];
  const urls = resources.map((resource) => `${origin}/pending?resource=${resource}`);
  const started = Promise.all(urls.map((url) => page.waitForRequest(url)));
  const failed = Promise.all(urls.map((url) => page.waitForEvent('requestfailed', (request) => request.url() === url)));
  await page.exposeFunction('abortsObserved', async () => { await failed; });
  const events: string[] = [];
  const load = async () => {
    await page.goto(`${origin}/spa-navigation`);
    await started;
    page.on('requestfailed', (request) => { events.push(request.failure()?.errorText ?? 'failed'); });
    page.on('framenavigated', () => { events.push('commit'); });
  };
  if (!loadInAction) await load();
  await watch.navigate(async () => {
    if (loadInAction) await load();
    await page.getByRole('link', { name: 'Navigate' }).click();
    await expect(page).toHaveURL(`${origin}/destination`);
  });
  expect(events).toEqual(['net::ERR_ABORTED', 'net::ERR_ABORTED', 'net::ERR_ABORTED', 'commit']);
  expectQuiet(watch);
});

test('watchPage reports an abort when the navigation action never commits', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.route('**/aborted', (route) => route.abort('aborted'));
  await watch.navigate(async () => {
    const failed = page.waitForEvent('requestfailed');
    await page.evaluate(() => fetch('/aborted').catch(() => undefined));
    await failed;
  });
  await watch.navigate(() => page.goto(`${origin}/destination`));
  expect(watch.failedRequests).toEqual([`GET ${origin}/aborted: net::ERR_ABORTED`]);
  expect(() => expectQuiet(watch)).toThrow();
});

test('watchPage retains a genuine abort before a navigation action begins', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.route('**/aborted', (route) => route.abort('aborted'));
  const failed = page.waitForEvent('requestfailed');
  await page.evaluate(() => fetch('/aborted').catch(() => undefined));
  await failed;
  await watch.navigate(() => page.goto(`${origin}/destination`));
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

test('watchPage retains a genuine abort across later unrelated navigations', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.route('**/aborted', (route) => route.abort('aborted'));
  const failed = page.waitForEvent('requestfailed');
  await page.evaluate(() => fetch('/aborted').catch(() => undefined));
  expect((await failed).failure()?.errorText).toBe('net::ERR_ABORTED');
  await page.goto(`${origin}/destination`);
  await page.goto(origin);
  expect(watch.failedRequests).toEqual([`GET ${origin}/aborted: net::ERR_ABORTED`]);
  expect(() => expectQuiet(watch)).toThrow();
});

test('watchPage stays quiet on a full-document link navigation with a pending fetch', async ({ page }) => {
  const watch = watchPage(page);
  const started = page.waitForRequest(`${origin}/pending`);
  await page.goto(`${origin}/document-navigation`);
  await started;
  await page.getByRole('link', { name: 'Navigate' }).click();
  await expect(page).toHaveURL(`${origin}/destination`);
  expectQuiet(watch);
});

test('watchPage retains a genuine abort when navigation cancels the same URL again', async ({ page }) => {
  const watch = watchPage(page);
  await page.goto(origin);
  await page.route('**/pending', (route) => route.abort('aborted'));
  const genuineAbort = page.waitForEvent('requestfailed');
  await page.evaluate(() => fetch('/pending').catch(() => undefined));
  await genuineAbort;
  await page.unroute('**/pending');
  const started = page.waitForRequest(`${origin}/pending`);
  await page.goto(`${origin}/navigation`);
  await started;
  const cancelled = page.waitForEvent('requestfailed', (request) => request.url() === `${origin}/pending`);
  await page.getByRole('link', { name: 'Navigate' }).click();
  await expect(page).toHaveURL(`${origin}/destination`);
  expect((await cancelled).failure()?.errorText).toBe('net::ERR_ABORTED');
  expect(watch.failedRequests).toEqual([`GET ${origin}/pending: net::ERR_ABORTED`]);
});

test('watchPage reports an old request aborted after two navigation commits', async ({ page }) => {
  const watch = watchPage(page);
  const started = page.waitForRequest(`${origin}/pending`);
  await page.goto(`${origin}/document-navigation`);
  await started;
  const failed = page.waitForEvent('requestfailed');
  await page.evaluate(`
    history.pushState({}, '', '/first');
    history.pushState({}, '', '/second');
    controller.abort();
  `);
  expect((await failed).failure()?.errorText).toBe('net::ERR_ABORTED');
  expect(watch.failedRequests).toEqual([`GET ${origin}/pending: net::ERR_ABORTED`]);
});
