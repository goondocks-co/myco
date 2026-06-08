// docs/lib/notfound.mjs
export function render404() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — Myco</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/assets/favicon-sage.svg">
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/docs.css">
</head>
<body class="docs-body">
<div style="max-width:560px;margin:0 auto;padding:140px 24px;text-align:center;font-family:var(--font-ui);">
  <div style="font-family:var(--font-heading);font-size:64px;color:var(--sage);">404</div>
  <h1 style="font-family:var(--font-heading);font-size:28px;color:var(--on-surface);margin:8px 0 12px;">This thread leads nowhere</h1>
  <p style="color:var(--on-surface-variant);margin-bottom:28px;">The page you're looking for isn't part of the network. Try the homepage or the docs index.</p>
  <div style="display:flex;gap:12px;justify-content:center;">
    <a class="btn btn-primary" href="/">Home<span class="chev">→</span></a>
    <a class="btn btn-outline" href="/#docs">Browse docs</a>
  </div>
</div>
</body>
</html>
`;
}
