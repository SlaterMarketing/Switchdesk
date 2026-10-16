// Fetches a web page for an @-mention and turns it into readable text for the agent.
'use strict';

const MAX = 40000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').replace(/\s+/g, ' ').trim();
  let body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [, html])[1];
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(pre|code)[^>]*>/gi, (m, t) => (t.toLowerCase() === 'pre' ? '\n```\n' : '`'))
    .replace(/<\/(pre)>/gi, '\n```\n')
    .replace(/<\/code>/gi, '`')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|tr|table|ul|ol|blockquote|h[1-6]|dl|dt|dd|figure|form)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  const text = decode(body)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

// Returns { url, title, text, truncated }, or throws with a message fit to show.
async function fetchPage(netFetch, url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https pages can be fetched.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await netFetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Switchdesk)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (!r.ok) throw new Error(`The page answered ${r.status}${r.statusText ? ' ' + r.statusText : ''}.`);
    const type = r.headers.get('content-type') || '';
    if (!/text|json|xml|javascript/i.test(type) && type) throw new Error(`That address is a ${type.split(';')[0]} file, not a page.`);
    const raw = await r.text();
    const page = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : { title: '', text: raw.trim() };
    const truncated = page.text.length > MAX;
    return { url: r.url || url, title: page.title, text: truncated ? page.text.slice(0, MAX) : page.text, truncated };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The page took too long to load.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPage, htmlToText };
