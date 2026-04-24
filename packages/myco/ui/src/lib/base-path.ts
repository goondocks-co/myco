export function getBasePath(): string {
  const match = window.location.pathname.match(/^\/p\/[^/]+/);
  return match ? match[0] : '';
}

export function withBasePath(routePath: string): string {
  const base = getBasePath();
  if (!base) return routePath;
  return `${base}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}
