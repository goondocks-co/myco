const DEFAULT_LOCALE = 'en-US';

export function formatTimestamp(value: number | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value * 1000).toLocaleString(DEFAULT_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatScore(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }

  return `${Math.round(value * 100)}%`;
}

export function titleCaseFromSnake(value: string): string {
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatCollectiveName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Collective';

  const words = trimmed.split(/[_-\s]+/g).filter(Boolean);
  const normalized = words
    .map((word) => {
      if (/^myco$/i.test(word)) return 'Myco';
      if (/^[a-z]{2,3}$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');

  return /collective/i.test(normalized) ? normalized : `${normalized} Collective`;
}
