// Bootstrap a JSDOM environment for component tests. Bun has no built-in
// `--dom-env` flag (as of 1.3.13), so we install JSDOM globals up-front via
// the [test] preload hook referenced from `bunfig.dom.toml`.

// React dedupe: the UI package has its own node_modules/react, which causes
// two React instances when tests import `@testing-library/react` (root) and
// the component under test (ui). Force all `react`/`react-dom` imports to
// resolve to the root-level copies.
import path from 'node:path';
import fs from 'node:fs';
const repoRoot = path.resolve(import.meta.dir, '..', '..');
Bun.plugin({
  name: 'react-dedupe',
  setup(build) {
    const routes: Array<[RegExp, string]> = [
      [/^react$/, path.join(repoRoot, 'node_modules/react/index.js')],
      [/^react\/jsx-runtime$/, path.join(repoRoot, 'node_modules/react/jsx-runtime.js')],
      [/^react\/jsx-dev-runtime$/, path.join(repoRoot, 'node_modules/react/jsx-dev-runtime.js')],
      [/^react-dom$/, path.join(repoRoot, 'node_modules/react-dom/index.js')],
      [/^react-dom\/client$/, path.join(repoRoot, 'node_modules/react-dom/client.js')],
      [/^react-dom\/test-utils$/, path.join(repoRoot, 'node_modules/react-dom/test-utils.js')],
    ];
    for (const [filter, target] of routes) {
      build.onResolve({ filter }, () => ({ path: target }));
    }
  },
});

// Warn when nested React copies still exist; `npm test` strips them before jsdom.
const NESTED_UI_NODE_MODULES = [
  path.join(repoRoot, 'packages/myco/ui/node_modules'),
  path.join(repoRoot, 'packages/myco-team/ui/node_modules'),
  path.join(repoRoot, 'packages/myco-server/ui/node_modules'),
];
const NESTED_REACT_PKGS = ['react', 'react-dom', 'react-router-dom', 'react-router', '@tanstack/react-query'];
for (const base of NESTED_UI_NODE_MODULES) {
  for (const pkg of NESTED_REACT_PKGS) {
    const dupe = path.join(base, pkg);
    if (fs.existsSync(dupe)) {
      console.warn(
        `[jsdom-preload] nested copy detected: ${path.relative(repoRoot, dupe)}\n` +
        '  -> hooks may break under direct `bun test`; prefer `npm test`, which strips these before the jsdom phase.',
      );
    }
  }
}

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLAnchorElement = dom.window.HTMLAnchorElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLFormElement = dom.window.HTMLFormElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.DocumentFragment = dom.window.DocumentFragment;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
// A dialog's focus scope walks and watches the tree it traps focus in.
g.MutationObserver = dom.window.MutationObserver;
g.NodeFilter = dom.window.NodeFilter;
if (g.ResizeObserver === undefined) {
  g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
}
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

// Components call `'Notification' in window` to feature-detect the browser
// Notifications API. Stub it as undefined-but-defined so the in-check passes
// without requiring a real Notification implementation.
class NotificationStub {
  static permission = 'default' as NotificationPermission;
  static requestPermission = async (): Promise<NotificationPermission> => 'default';
  constructor(public title: string, public options?: NotificationOptions) {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
(dom.window as unknown as Record<string, unknown>).Notification = NotificationStub;
g.Notification = NotificationStub;

// Mirror the existing vitest setup (localStorage + matchMedia shims).
await import('./vitest.js');
