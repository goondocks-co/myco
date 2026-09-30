/**
 * The checks every screens page runs, and the screenshot helper.
 *
 * Per page, on fixture data (build plan §5.1): landmarks render, no console
 * errors and no failed requests, axe-core finds nothing serious or critical,
 * no raw id reaches visible text outside a facts panel, a list page carries
 * exactly one filter bar, nothing scrolls sideways, and screenshots land at
 * 1280×820 and 390×844 in dark and light.
 *
 * On the fixture, every page runs in a fixed time zone and locale with the
 * browser's clock held at `FIXTURE_NOW`, and any request that leaves the
 * launcher's origin is aborted, which the failed-request check then reports.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_LOCALE, FIXTURE_NOW, FIXTURE_TIMEZONE, SCREENS_ENV, screensEnv } from './env.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHOTS_DIR = path.join(REPO, 'target', 'ui-screens', 'shots');

export const VIEWPORTS = {
  desktop: { width: 1280, height: 820 },
  phone: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export const MODES = ['dark', 'light'] as const;
export type Mode = (typeof MODES)[number];

/** Every viewport and mode pair a page is shot in. */
export const SHOT_MATRIX: ReadonlyArray<{ viewport: ViewportName; mode: Mode }> = (Object.keys(VIEWPORTS) as ViewportName[])
  .flatMap((viewport) => MODES.map((mode) => ({ viewport, mode })));

/** Ids a reader never needs to see: runs, projects, members and credentials, base64url included. */
export const RAW_ID = /\b(run|proj|mem|mt)_[\w-]{6,}/;

/** The appearance the dashboard reads before it paints, keyed as `lib/appearance-apply.ts` stores it. */
export const APPEARANCE_KEY = 'myco-appearance';

export function baseUrl(): string {
  return screensEnv('url');
}

/** Adds a complete `name=value` session cookie to a context, scoped to the base URL's origin. */
export async function signIn(context: BrowserContext, cookie: string): Promise<void> {
  const split = cookie.indexOf('=');
  if (split <= 0) throw new Error('a session cookie is a name=value pair');
  const url = new URL(baseUrl());
  await context.addCookies([{
    name: cookie.slice(0, split),
    value: cookie.slice(split + 1),
    domain: url.hostname,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

/** Sets the viewer's appearance before any page script runs. */
export async function setAppearance(context: BrowserContext, mode: Mode): Promise<void> {
  await context.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* storage refused: the page paints its default */ }
  }, [APPEARANCE_KEY, JSON.stringify({ theme: 'sage', mode, font: 'default', density: 'normal' })] as const);
}

export interface PageWatch {
  consoleErrors: string[];
  failedRequests: string[];
}

/** Records console errors, uncaught page errors and failed requests (network failures and 4xx/5xx answers). */
export function watchPage(page: Page): PageWatch {
  const watch: PageWatch = { consoleErrors: [], failedRequests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') watch.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => { watch.consoleErrors.push(`uncaught: ${error.message}`); });
  page.on('requestfailed', (request) => {
    watch.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) watch.failedRequests.push(`${response.request().method()} ${response.url()}: ${response.status()}`);
  });
  return watch;
}

export function expectQuiet(watch: PageWatch): void {
  expect(watch.consoleErrors, 'console errors').toEqual([]);
  expect(watch.failedRequests, 'failed requests').toEqual([]);
}

/** axe-core over the page, or only the parts `include` selects: no serious or critical violation. */
export async function expectAxeClean(page: Page, include: readonly string[] = []): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const selector of include) builder = builder.include(selector);
  const results = await builder.analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
  expect(blocking, 'serious or critical accessibility violations').toEqual([]);
}

/** Visible text nodes carrying a raw id, outside any `[data-facts]` panel; only under the elements `within` selects, when given. */
export async function rawIdsInText(page: Page, within?: string): Promise<string[]> {
  return page.evaluate(([source, scope]) => {
    const pattern = new RegExp(source);
    const hits: string[] = [];
    const roots = scope === null ? [document.body] : [...document.querySelectorAll(scope)];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        const match = pattern.exec(text);
        if (!match) continue;
        const parent = node.parentElement;
        if (parent === null || parent.closest('[data-facts]') !== null) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || parent.getClientRects().length === 0) continue;
        hits.push(`${match[0]} in <${parent.tagName.toLowerCase()}>`);
      }
    }
    return hits;
  }, [RAW_ID.source, within ?? null] as const);
}

export async function expectNoRawIds(page: Page, within?: string): Promise<void> {
  expect(await rawIdsInText(page, within), 'raw ids in visible text').toEqual([]);
}

export interface FilterBarMetrics {
  /** How many filter bars the page renders. A list page has exactly one. */
  count: number;
  /** The search input's box, in CSS pixels, when there is exactly one bar. */
  input: { height: number; left: number; width: number } | null;
  /** The bar's own width, in CSS pixels. */
  barWidth: number | null;
}

/** The filter bar a list page renders, its search input's height, left edge and width, and the bar's width. */
export async function filterBarMetrics(page: Page): Promise<FilterBarMetrics> {
  const bars = page.locator('[data-filter-bar]');
  const count = await bars.count();
  if (count !== 1) return { count, input: null, barWidth: null };
  const [box, bar] = await Promise.all([bars.first().locator('input').first().boundingBox(), bars.first().boundingBox()]);
  return { count, input: box === null ? null : { height: box.height, left: box.x, width: box.width }, barWidth: bar?.width ?? null };
}

/** The share of its bar a search box fills at the least: the search leads the bar, it is never a short box beside the filters. */
export const SEARCH_MIN_SHARE = 0.55;

/**
 * Every list page's search box matches the first one's height and left edge
 * within 1px, and fills at least `SEARCH_MIN_SHARE` of its bar.
 */
export function expectUniformSearch(metrics: Array<{ page: string; metrics: FilterBarMetrics }>): void {
  for (const { page, metrics: m } of metrics) expect({ page, count: m.count }).toEqual({ page, count: 1 });
  const [first, ...rest] = metrics;
  if (!first?.metrics.input) throw new Error('no search input measured');
  for (const { page, metrics: m } of metrics) {
    expect(m.input, `${page} search input`).not.toBeNull();
    expect(m.barWidth, `${page} filter bar`).not.toBeNull();
    expect(m.input!.width / m.barWidth!, `${page} search width as a share of its bar`).toBeGreaterThanOrEqual(SEARCH_MIN_SHARE);
  }
  for (const { page, metrics: m } of rest) {
    expect(Math.abs(m.input!.height - first.metrics.input.height), `${page} search height`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.input!.left - first.metrics.input.left), `${page} search left edge`).toBeLessThanOrEqual(1);
  }
}

export function shotPath(name: string, viewport: ViewportName, mode: Mode, dir = SHOTS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${viewport}-${mode}.png`);
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  watch: PageWatch;
}

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

/** A fresh context at one viewport and mode, signed in when a cookie is given, with the page watched from its first request. */
export async function openPage(browser: Browser, options: { path: string; viewport: ViewportName; mode: Mode; cookie?: string }): Promise<OpenedPage> {
  const context = await browser.newContext({
    viewport: VIEWPORTS[options.viewport],
    colorScheme: options.mode,
    ...(onFixture() ? { timezoneId: FIXTURE_TIMEZONE, locale: FIXTURE_LOCALE } : {}),
  });
  const origin = new URL(baseUrl()).origin;
  await context.route((url) => url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin, (route) => route.abort('blockedbyclient'));
  if (options.cookie) await signIn(context, options.cookie);
  await setAppearance(context, options.mode);
  const page = await context.newPage();
  if (onFixture()) await page.clock.setFixedTime(FIXTURE_NOW);
  const watch = watchPage(page);
  await page.goto(new URL(options.path, baseUrl()).href);
  return { context, page, watch };
}

/** How far the page, and each `main` landmark, reaches past its own width. */
export async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth) {
      out.push(`document ${doc.scrollWidth}px in a ${window.innerWidth}px window`);
      // Name where the overflow starts: elements past the edge whose parent is not.
      const past = (el: Element) => el.getBoundingClientRect().right > window.innerWidth + 1;
      const origins = [...document.body.querySelectorAll('*')].filter((el) => past(el) && el.parentElement !== null && !past(el.parentElement));
      for (const el of origins.slice(0, 5)) {
        const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 6).join('.') : '';
        out.push(`  starts at <${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> right edge ${Math.round(el.getBoundingClientRect().right)}px`);
      }
    }
    for (const main of document.querySelectorAll('main')) {
      if (main.scrollWidth > main.clientWidth + 1) out.push(`main ${main.scrollWidth}px in ${main.clientWidth}px`);
    }
    return out;
  });
}

/** Nothing on the page scrolls sideways: a wide element wraps or scrolls inside its own box. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await horizontalOverflow(page), 'horizontal overflow').toEqual([]);
}

/** A full-page screenshot under `target/ui-screens/shots/<name>-<viewport>-<mode>.png`. */
export async function shoot(page: Page, name: string, viewport: ViewportName, mode: Mode, dir = SHOTS_DIR): Promise<string> {
  const file = shotPath(name, viewport, mode, dir);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}
