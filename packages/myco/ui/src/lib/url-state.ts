// SPDX-License-Identifier: Apache-2.0

export function appendSearchHash(base: string, search = '', hash = ''): string {
  return `${base}${search}${hash}`;
}

export function parseOffset(raw: string | null | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export interface QueryValueSpec {
  value: string | number | boolean | null | undefined;
  defaultValue?: string | number | boolean;
}

export function updateQueryValues(
  search: string,
  updates: Record<string, QueryValueSpec>,
): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const [key, spec] of Object.entries(updates)) {
    const value = spec.value;
    const defaultValue = spec.defaultValue;
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (defaultValue !== undefined && String(value) === String(defaultValue))
    ) {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

export function pathnameWithSearchHash(
  pathname: string,
  searchParams: URLSearchParams,
  hash = '',
): string {
  const search = searchParams.toString();
  return `${pathname}${search ? `?${search}` : ''}${hash}`;
}

export function stripTrailingSegment(pathname: string, segment: string | undefined): string {
  if (!segment) return pathname;
  const suffix = `/${segment}`;
  return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname;
}
