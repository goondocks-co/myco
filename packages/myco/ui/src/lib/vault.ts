/** Sum all spore counts across types. */
export function totalSpores(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}
