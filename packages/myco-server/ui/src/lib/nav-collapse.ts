const NAV_COLLAPSED_KEY = 'myco-nav-collapsed';

/** Whether this viewer left the nav collapsed to its rail. Storage may be blocked or empty; either reads as expanded. */
export function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberNavCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(NAV_COLLAPSED_KEY, '1');
    else localStorage.removeItem(NAV_COLLAPSED_KEY);
  } catch {
    // Storage blocked: the choice holds until the page reloads.
  }
}
