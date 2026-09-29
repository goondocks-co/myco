/**
 * Schema v56: the lines a transcript's cursor stands past within its segment.
 *
 * A pass dates a line its format leaves undated by its segment's time plus the line breaks before it in that
 * segment, counted from the segment's first byte (`datedByPosition`). A pass that reads its segment from the cursor
 * rather than from its first byte starts that count here: the line breaks between the segment's first byte and the
 * cursor, written with every cursor move. NULL is not known, and the pass reads the whole segment once to count them.
 */
export const V56_STATEMENTS: readonly string[] = [
  `ALTER TABLE transcripts ADD COLUMN parse_segment_lines INTEGER`,
];
