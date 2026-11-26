import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Escape for the dashboard's dialogs and panels, owned in one place.
 *
 * A layer joins the moment its element is attached to the page, through the ref `useLayer` returns, and leaves when
 * it is detached. One document listener answers each Escape by closing the open layer last in document order, which
 * is the one on top, and nothing else. A layer never waits for its own key handling to be set up, so an Escape that
 * lands the instant a confirmation appears inside a panel closes the confirmation alone.
 *
 * Radix's own Escape handling is turned off for these layers: each claims the key it is offered (`claimEscape`) so the
 * listener knows the key reached a layer of ours. A key some other control already used, such as an open menu or a
 * list inside the dialog, arrives here prevented and unclaimed, and is left alone.
 */
const layers = new Map<HTMLElement, () => void>();
const claimed = new WeakSet<Event>();

function topmost(): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  for (const element of layers.keys()) {
    if (!element.isConnected) continue;
    if (top === undefined || top.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) top = element;
  }
  return top;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (event.defaultPrevented && !claimed.has(event)) return;
  const top = topmost();
  if (top === undefined) return;
  event.preventDefault();
  layers.get(top)?.();
}

function join(element: HTMLElement, close: () => void): void {
  if (layers.size === 0) document.addEventListener('keydown', onKeyDown);
  layers.set(element, close);
}

function leave(element: HTMLElement): void {
  layers.delete(element);
  if (layers.size === 0) document.removeEventListener('keydown', onKeyDown);
}

/** Marks an Escape a layer of ours was offered, so Radix leaves it and the one listener closes the topmost layer. */
export function claimEscape(event: KeyboardEvent | ReactKeyboardEvent): void {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  claimed.add(native);
  native.preventDefault();
}

/**
 * The ref that makes an element a layer closed by `close` on Escape, from the moment it is attached. `close` is read
 * when the key arrives, so the newest one is used.
 */
export function useLayer<T extends HTMLElement>(close: (() => void) | null): (node: T | null) => void {
  const latest = useRef(close);
  latest.current = close;
  const attached = useRef<T | null>(null);
  return useCallback((node: T | null) => {
    if (attached.current !== null) leave(attached.current);
    attached.current = node;
    if (node !== null && latest.current !== null) join(node, () => latest.current?.());
  }, []);
}
