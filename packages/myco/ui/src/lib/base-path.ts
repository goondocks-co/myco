export function getBasePath(): string {
  return '';
}

export function withBasePath(routePath: string): string {
  return routePath.startsWith('/') ? routePath : `/${routePath}`;
}
