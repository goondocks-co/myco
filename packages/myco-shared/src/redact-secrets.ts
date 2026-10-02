/** Access-key and password shapes are replaced before stored text is displayed or logged. */
export function redactSecrets(input: string): string {
  return input
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{36,}/g, 'ghp_[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{36,}/g, 'github_pat_[REDACTED]')
    .replace(/auth[_-]?token=[A-Za-z0-9._-]+/gi, 'auth_token=[REDACTED]')
    .replace(/\b((?:[\w-]+[_-])?(?:token|secret|password|api[_-]?key))(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, '$1$2[REDACTED]')
    .replace(/(\bhttps?:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1[REDACTED]@');
}
