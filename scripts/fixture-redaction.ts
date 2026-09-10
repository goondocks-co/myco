/** Shared redaction rules for published transcript and evaluation fixtures. */
export const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a home directory path', pattern: /\/(?:Users|home)\/(?!fixture\b|test\b)[A-Za-z0-9._-]+/ },
  { name: 'a Windows user profile path', pattern: /[A-Za-z]:\\\\?Users\\\\?(?!fixture\b|test\b)[A-Za-z0-9._-]+/i },
  { name: 'an ssh or pem private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'an Anthropic or OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'a bearer credential', pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'a Myco member credential', pattern: /\bmt_[A-Za-z0-9_-]{12,}\b/ },
  { name: 'an email address', pattern: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|fixture\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'a routable IPv4 address', pattern: /\b(?!0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.)(?:\d{1,3}\.){3}\d{1,3}\b/ },
];

export interface FixtureFinding {
  line: number;
  rule: string;
}

export function scanFixture(content: string): FixtureFinding[] {
  return content.split('\n').flatMap((line, index) =>
    FORBIDDEN.filter(({ pattern }) => pattern.test(line))
      .map(({ name }) => ({ line: index + 1, rule: name })),
  );
}
