// docs/lib/links.mjs
import path from 'node:path';

const REPO_BLOB = 'https://github.com/goondocks-co/myco/blob/main';

function splitAnchor(href) {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

// fromSlug is the source page slug, e.g. 'quickstart' or
// 'architecture/actors-and-boundaries'.
export function rewriteLink(href, fromSlug) {
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) {
    return href;
  }
  const [pathPart, anchor] = splitAnchor(href);
  if (!pathPart.endsWith('.md')) return href;

  const fromDir = path.posix.dirname(fromSlug); // 'architecture' or '.'
  const base = fromDir === '.' ? '' : fromDir;
  const resolved = path.posix.normalize(path.posix.join(base, pathPart));

  if (resolved.startsWith('..')) {
    // Resolves above docs/ -> point at the file in the GitHub repo.
    const repoPath = path.posix
      .normalize(path.posix.join('docs', base, pathPart))
      .replace(/^(\.\.\/)+/, '');
    return `${REPO_BLOB}/${repoPath}${anchor}`;
  }
  return '/' + resolved.replace(/\.md$/, '') + anchor;
}

export function rewriteHtmlLinks(html, fromSlug) {
  return html.replace(/href="([^"]+)"/g, (_m, href) => `href="${rewriteLink(href, fromSlug)}"`);
}
