/**
 * The design system specimen: every token and component the dashboard builds
 * from, on one page. It renders its content inside its landmarks, logs no
 * errors, scrolls nowhere sideways, passes axe-core with nothing serious or
 * critical, and is shot at every viewport in both modes. The tap-target check
 * is proved on a planted page.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAxeClean, expectFits, expectQuiet, openPage, shoot, SHOT_MATRIX, smallTapTargets, TAP_MIN, VIEWPORTS } from './checks.ts';
import { SCREENS_ENV } from './env.ts';

const SPECIMEN = '/specimen/index.html';

test.describe('design specimen', () => {
  test.skip(process.env[SCREENS_ENV.fixture] !== '1', 'the specimen is served only by the screens launcher');

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${viewport} ${mode}`, async ({ browser }) => {
      expect(process.env[SCREENS_ENV.specimen], 'the launcher served no specimen; run `npm run build:specimen --prefix packages/myco-server/ui` first').toBe('1');
      const { context, page, watch } = await openPage(browser, { path: `${SPECIMEN}?mode=${mode}`, viewport, mode });
      try {
        await page.locator('html[data-ready="1"]').waitFor();
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'Learn from sessions' })).toBeVisible();
        await expect(page.getByText('Canopy parity verified against the hosted map')).toBeVisible();
        // A row's kicker sits above its title, inside the row.
        const kicked = page.locator('[data-specimen-kicker]').getByRole('link');
        const [kicker, title] = await Promise.all([kicked.getByText('Gotcha').boundingBox(), kicked.getByText('A reserved test port races the ephemeral fallback').boundingBox()]);
        expect(kicker!.y + kicker!.height).toBeLessThanOrEqual(title!.y);
        // Sibling rows draw a divider under every row but the last.
        const dividers = await page.locator('[data-specimen-kicker] > *').evaluateAll((rows) => rows.map((row) => getComputedStyle(row).borderBottomWidth));
        expect(dividers).toEqual(['1px', '1px', '1px', '1px', '0px']);
        // A reported artifact links its URL only where the page names its host, and a long URL wraps inside the row.
        const [linkedRow, plainRow] = [page.locator('[data-specimen-kicker] > *').nth(2), page.locator('[data-specimen-kicker] > *').nth(3)];
        await expect(linkedRow.getByRole('link', { name: 'https://github.com/goondocks-co/myco/pull/1931' })).toBeVisible();
        await expect(plainRow.getByRole('link')).toHaveCount(0);
        expect(await plainRow.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(plainRow.getByRole('button', { name: 'Copy link' })).toBeVisible();
        // A wrapping row keeps all its words, and its copy control keeps its name where only the icon shows.
        const wrapped = page.locator('[data-specimen-kicker] > *').last();
        await expect(wrapped.getByText('Released · myco/v2.0.3 · PR #1873 · checked 30 min ago')).toBeVisible();
        expect(await wrapped.getByText('Ended at 8d41b7e, couldn’t tell whether files changed').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(wrapped.getByRole('button', { name: 'Copy commit' })).toBeVisible();
        // Lanes nest as lists, mark the current lane without a link to itself, and draw their tracks from the md width only.
        const lanes = page.locator('[data-specimen-lanes]').getByRole('list', { name: 'Lineage' });
        await expect(lanes.getByRole('listitem')).toHaveCount(5);
        await expect(lanes.locator('[aria-current="true"]')).toContainText('Flaky test port collision fixed');
        await expect(lanes.locator('[aria-current="true"]').getByRole('link')).toHaveCount(0);
        await expect(lanes.getByRole('link')).toHaveText(['Release checks coordinated', 'Port allocation reviewed']);
        await expect(lanes.getByText('A session not captured here', { exact: true })).toBeVisible();
        const tracks = lanes.locator('[data-lane-track]');
        if (viewport === 'phone') await expect(tracks.first()).toBeHidden(); else await expect(tracks.first()).toBeVisible();
        await expectFits(page, viewport);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'design', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('the tap-target check', () => {
  test('finds a target under the least a finger needs, and passes one that meets it', async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORTS.phone });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><body style="margin:0;font:15px sans-serif">
        <button id="small" style="position:absolute;left:20px;top:20px;width:28px;height:28px">x</button>
        <button id="big" style="position:absolute;left:100px;top:20px;width:${TAP_MIN}px;height:${TAP_MIN}px">y</button>
        <ul style="position:absolute;left:20px;top:120px;margin:0;padding:0;list-style:none">
          <li style="height:30px"><a href="#a">Crowded one</a></li>
          <li style="height:30px"><a href="#b">Crowded two</a></li>
        </ul>
        <div style="position:absolute;left:20px;top:220px;width:300px;height:60px">
          <a href="#row" style="display:block;width:120px">Row link</a>
          <span style="position:absolute;inset:0" onclick="0"></span>
        </div>
        <div style="position:absolute;left:20px;top:320px;width:300px;height:60px">
          <a href="#stretched" style="position:static">Whole row</a>
          <style>a[href="#stretched"]::after{content:"";position:absolute;inset:0}</style>
        </div>
        <p style="position:absolute;left:20px;top:420px;width:300px">Words around <a href="#inline">a link in a sentence</a> are left out.</p>
        <div style="position:absolute;left:20px;top:580px;width:300px;display:flex;flex-direction:column">
          <p style="margin:0">A paragraph of words above the link, which are not the link's line.</p>
          <a href="#action" style="font-size:13px">Open the run →</a>
        </div>
        <label style="position:absolute;left:20px;top:500px;display:flex;align-items:center;gap:8px;height:48px;width:200px">
          <input type="checkbox" id="box" style="width:16px;height:16px"> Labelled box
        </label>
      </body>`);
      const found = await smallTapTargets(page);
      const names = found.map((line) => line.split('"')[1]);
      expect(names.sort()).toEqual(['Crowded one', 'Crowded two', 'Open the run →', 'Row link', 'x'].sort());
    } finally {
      await context.close();
    }
  });
});

/** How many times each layer case is opened and dismissed, each way, to catch a key that lands before a layer settles. */
const LAYER_ROUNDS = 10;

/**
 * Presses Escape at the instant a new dialog is attached to the page, before it is visible or settled: once from inside
 * the mutation that attaches it, once as a real key press right after it is attached.
 */
async function escapeOnAttach(page: Page, open: () => Promise<void>, way: 'mutation' | 'keyboard'): Promise<void> {
  if (way === 'mutation') {
    await page.evaluate(() => {
      const before = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length <= before) return;
        observer.disconnect();
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await open();
    return;
  }
  const count = await page.locator('[role="dialog"], [role="alertdialog"]').count();
  await open();
  await page.locator('[role="dialog"], [role="alertdialog"]').nth(count).waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');
}

/** Opens `upper` from `opener` and dismisses it at once, each way, `LAYER_ROUNDS` times; `lower` (when any) stays open. */
async function closesAlone(page: Page, opener: Locator, upper: string, lower: Locator | null): Promise<void> {
  for (const way of ['mutation', 'keyboard'] as const) {
    for (let round = 0; round < LAYER_ROUNDS; round += 1) {
      await escapeOnAttach(page, () => opener.click(), way);
      await expect(page.getByRole('dialog', { name: upper })).toHaveCount(0);
      if (lower !== null) await expect(lower).toBeVisible();
      await expect(opener).toBeFocused();
    }
  }
}

test.describe('layers inside layers', () => {
  test.skip(process.env[SCREENS_ENV.fixture] !== '1', 'the specimen is served only by the screens launcher');

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`a confirmation in a panel, one in a dialog, and a dialog alone each close alone on an immediate Escape ${viewport}`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { path: `${SPECIMEN}?mode=dark`, viewport, mode: 'dark' });
      try {
        await page.locator('html[data-ready="1"]').waitFor();
        const layers = page.locator('[data-specimen-layers]');

        await layers.getByRole('button', { name: 'Open a panel' }).click();
        const panel = page.getByTestId('specimen-panel');
        await expect(panel).toBeVisible();
        await closesAlone(page, panel.getByRole('button', { name: 'Cancel run' }), 'Cancel this run?', panel);
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);

        await layers.getByRole('button', { name: 'Open a dialog with a confirmation' }).click();
        const outer = page.getByRole('dialog', { name: 'Access key' });
        await expect(outer).toBeVisible();
        await closesAlone(page, outer.getByRole('button', { name: 'Revoke key' }), 'Revoke this key?', outer);
        await page.keyboard.press('Escape');
        await expect(outer).toHaveCount(0);

        await closesAlone(page, page.getByRole('button', { name: 'Open a dialog', exact: true }), 'Rename project', null);
      } finally {
        await context.close();
      }
    });
  }
});
