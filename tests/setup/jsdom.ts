// Bootstrap a JSDOM environment for component tests. Bun has no built-in
// `--dom-env` flag (as of 1.3.13), so we install JSDOM globals up-front via
// the [test] preload hook referenced from `bunfig.dom.toml`.
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
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

// Mirror the existing vitest setup (localStorage + matchMedia shims).
await import('./vitest.js');
