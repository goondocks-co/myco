/**
 * Shared Canopy types. Row-shape (`CanopyEntry`) lives in db/schema.ts
 * because that's where the other row types are published.
 */

export interface CanopyParserInput {
  /** Repo-relative path (forward-slash). */
  path: string;
  /** UTF-8 file contents. */
  content: string;
  sizeBytes: number;
  lineCount: number;
}

export interface CanopyParserOutput {
  language: string | null;
  exports: string[];
  imports: string[];
  topComment: string | null;
}

export type CanopyParser = (input: CanopyParserInput) => CanopyParserOutput;

export interface CanopyScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  errored: number;
  durationMs: number;
}

/**
 * Injection-time blob shape. Composed by Track B from a persisted
 * CanopyEntry; `summary` is populated from `llm_description` when present.
 */
export interface CanopyBlob {
  path: string;
  tokenEstimate: number;
  lineCount: number;
  exports: string[];
  imports: string[];
  top: string | null;
  summary: string | null;
}
