/** Source the harness-name gate reads: every `cursor` here is a pagination key, so none is a harness. */
export const OPTION_KEYS = ['type', 'mode', 'order', 'cursor'] as const;

export const SCHEMA = {
  properties: {
    order: { type: 'string' },
    'cursor': { type: 'string', description: 'where the next page starts' },
  },
};

export function pageOf(searchParams: URLSearchParams): string | null {
  return searchParams.get('cursor');
}
