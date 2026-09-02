import crypto from 'node:crypto';

/** sha256 over UTF-8 text, hex. */
export const sha256Text = (text: string): string => crypto.createHash('sha256').update(text, 'utf-8').digest('hex');

/** The first top-level markdown heading, when the text has one. */
export const firstHeading = (content: string): string | undefined => /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
