/** A vector of `dimensions` that points one way for text about architecture and another for anything else. */
export function switchVector(text: string, dimensions: number): number[] {
  const about = text.includes('architecture');
  return Array.from({ length: dimensions }, (_, i) => i === 0 ? (about ? 1 : 0) : i === 1 ? (about ? 0 : 1) : i === 2 ? 0.05 : 0);
}
