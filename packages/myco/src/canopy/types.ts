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
