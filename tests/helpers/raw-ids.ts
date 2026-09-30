/**
 * The ids a reader of the dashboard never needs to see, as one pattern every
 * screen check and jsdom suite uses:
 * - runs, projects, members and credentials: `run_`, `proj_`, `mem_`, `mt_` and base64url;
 * - UUIDs: plan keys and session ids;
 * - spore ids, `<type>-<8 hex>` as `mintSporeId` makes them. The type is
 *   whatever the writer named, so the pattern takes any lowercase word joined
 *   by `_` or `-`; `raw-ids.test.ts` holds it to every observation type.
 *
 * It imports nothing, so a screen check can hand its source to the browser.
 */
export const RAW_ID = new RegExp([
  String.raw`\b(?:run|proj|mem|mt)_[\w-]{6,}`,
  String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`,
  String.raw`\b[a-z]+(?:[_-][a-z]+)*-[0-9a-f]{8}\b`,
].join('|'));

/**
 * Visible text under `root` that carries a raw id, outside any `[data-facts]`
 * panel (the one place an id may show, to be copied) and outside `ignore`.
 */
export function rawIdsIn(root: Node, ignore: readonly string[] = []): string[] {
  const hits: string[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const match = RAW_ID.exec(node.textContent ?? '');
    const parent = node.parentElement;
    if (match === null || parent === null || parent.closest('[data-facts]') !== null) continue;
    if (ignore.some((selector) => parent.closest(selector) !== null)) continue;
    hits.push(match[0]);
  }
  return hits;
}
