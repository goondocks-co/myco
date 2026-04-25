export function getBasePath(): string {
  const hubPrefix = (window as Window & { __MYCO_HUB_PREFIX__?: string }).__MYCO_HUB_PREFIX__;
  if (hubPrefix) return hubPrefix;

  const match = window.location.pathname.match(/^\/p\/[^/]+/);
  return match ? match[0] : '';
}

export function withBasePath(routePath: string): string {
  const base = getBasePath();
  if (!base) return routePath;
  return `${base}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}
