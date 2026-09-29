/**
 * The recall gold set's frozen embeddings, answered by the text they embed.
 *
 * Every vector in `tests/fixtures/evals/recall/vectors.bin` is production's
 * bge-m3 vector, and each row names the sha256 of the exact text the server
 * hands its embedding provider for it: a spore's `content + "\n"`, a plan's
 * `title + "\n" + content`, a case's prompt. A text the fixture does not hold
 * throws rather than answering, so a seed or a prompt that drifts from the
 * fixture fails the run instead of being scored against a vector it never had.
 *
 * Pure: the Bun stub and the parity Worker both build on it.
 */
export interface VectorRow {
  kind: 'spore' | 'plan' | 'prompt';
  id: string;
  embedKey: string;
  row: number;
}

export interface VectorIndexFile {
  dims: number;
  rows: VectorRow[];
}

export class UnknownFixtureText extends Error {}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The vector each fixture text embeds to; `data` is little-endian float32, `dims` values per row. */
export function fixtureLookup(index: VectorIndexFile, data: ArrayBuffer): { vectorFor(text: string): Promise<number[]> } {
  const byKey = new Map(index.rows.map((r) => [r.embedKey, r]));
  if (byKey.size !== index.rows.length) throw new Error('the recall fixture holds two rows for one text');
  if (data.byteLength !== index.rows.length * index.dims * 4) throw new Error('the recall fixture vectors do not match their index');
  const view = new DataView(data);
  return {
    async vectorFor(text) {
      const row = byKey.get(await sha256Hex(text));
      if (row === undefined) throw new UnknownFixtureText(`the recall fixture holds no vector for this text (${text.length} chars): ${text.slice(0, 80)}`);
      const offset = row.row * index.dims * 4;
      return Array.from({ length: index.dims }, (_, i) => view.getFloat32(offset + i * 4, true));
    },
  };
}
