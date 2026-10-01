import { JOIN_A_DEPLOYMENT } from '../member/join-guidance.js';

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What the 1.4 daemon serves at every dashboard path: a page with no script saying the 1.4 dashboard is retired, and
 * how to reach a Deployment's dashboard instead.
 */
export const RETIRED_DASHBOARD_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Myco</title></head>'
  + '<body><p>The 1.4 dashboard is retired. Your dashboard is your Deployment&rsquo;s: run <code>myco open</code> in a project that has joined one.</p>'
  + `<p>${escapeHtml(JOIN_A_DEPLOYMENT)}</p></body></html>`;
