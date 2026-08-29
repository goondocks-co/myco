const PENDING_LINK_KEY = 'myco-pending-link';

/** A link key waiting for sign-in to complete, held for this tab only. */
export function readPendingLink(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_LINK_KEY);
  } catch {
    return null;
  }
}

export function holdPendingLink(key: string): void {
  try {
    window.sessionStorage.setItem(PENDING_LINK_KEY, key);
  } catch {
    // Storage disabled: the key lives only in this page's memory.
  }
}

export function clearPendingLink(): void {
  try {
    window.sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch {
    // Nothing held.
  }
}
