/**
 * Converts parsed WinHelp topic data to clean HTML.
 */

'use strict';

/* ─────────────────────────────────────────────
   Render a single topic to an HTML string
───────────────────────────────────────────── */
function renderTopic(topic) {
  const lines = (topic.text || '').split('\n');
  const parts = [];
  let inPre   = false;
  let listBuf = null; // null | 'ul' | 'ol'

  function flushList() {
    if (listBuf) { parts.push(`</${listBuf}>`); listBuf = null; }
  }

  for (let raw of lines) {
    const line = raw.trimEnd();

    /* Detect bullet list items starting with -, *, • */
    if (/^[-*•]\s+/.test(line)) {
      if (listBuf !== 'ul') { flushList(); parts.push('<ul>'); listBuf = 'ul'; }
      parts.push(`<li>${escapeHtml(line.replace(/^[-*•]\s+/, ''))}</li>`);
      continue;
    }

    /* Detect numbered list: "1." "2." etc. */
    if (/^\d+\.\s+/.test(line)) {
      if (listBuf !== 'ol') { flushList(); parts.push('<ol>'); listBuf = 'ol'; }
      parts.push(`<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    flushList();

    if (line === '') {
      parts.push('<br>');
      continue;
    }

    /* Horizontal rule: "---" or "===" spanning most of the line */
    if (/^[-=_]{4,}$/.test(line.trim())) {
      parts.push('<hr>');
      continue;
    }

    /* Tab-indented → code-like block */
    if (line.startsWith('\t') || line.startsWith('    ')) {
      if (!inPre) { parts.push('<pre>'); inPre = true; }
      parts.push(escapeHtml(line) + '\n');
      continue;
    }

    if (inPre) { parts.push('</pre>'); inPre = false; }

    parts.push(`<p>${formatInline(line)}</p>`);
  }

  flushList();
  if (inPre) parts.push('</pre>');

  return `<div class="hlp-topic">${parts.join('')}</div>`;
}

/* ─────────────────────────────────────────────
   Inline formatting (bold, italic, links)
───────────────────────────────────────────── */
function formatInline(text) {
  let s = escapeHtml(text);

  /* **bold** or __bold__ */
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) =>
    `<strong>${a || b}</strong>`);

  /* *italic* or _italic_ */
  s = s.replace(/\*(.+?)\*|_(.+?)_/g, (_, a, b) =>
    `<em>${a || b}</em>`);

  /* `code` */
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  return s;
}

/* ─────────────────────────────────────────────
   Generate a standalone downloadable HTML page
───────────────────────────────────────────── */
function buildDownloadPage(topic, helpTitle) {
  const body = renderTopic(topic);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(topic.title)} — ${escapeHtml(helpTitle)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 800px; margin: 2rem auto; padding: 0 1.5rem;
           color: #1e293b; background: #fff; line-height: 1.7; }
    h1   { font-size: 1.6rem; margin-bottom: 1.2rem; }
    a    { color: #2563eb; }
    pre  { background: #f5f6fa; border: 1px solid #dde1ea; border-radius: 6px;
           padding: .8rem 1rem; overflow-x: auto; }
    code { font-family: Consolas, monospace; font-size: .87em; }
    hr   { border: none; border-top: 1px solid #dde1ea; margin: 1em 0; }
    table{ border-collapse: collapse; width: 100%; }
    td,th{ border: 1px solid #dde1ea; padding: .35rem .6rem; }
    th   { background: #f5f6fa; }
  </style>
</head>
<body>
  <h1>${escapeHtml(topic.title)}</h1>
  ${body}
</body>
</html>`;
}

/* ─────────────────────────────────────────────
   Build a ZIP of all topics using JSZip (if available)
   or falls back to a single-file HTML index.
───────────────────────────────────────────── */
async function buildZip(topics, helpTitle) {
  if (typeof JSZip === 'undefined') {
    /* Fallback: single HTML with all topics */
    return buildSingleHtml(topics, helpTitle);
  }

  const zip = new JSZip();

  for (const topic of topics) {
    const filename = sanitizeFilename(topic.title) + '.html';
    zip.file(filename, buildDownloadPage(topic, helpTitle));
  }

  /* Index page */
  const indexLinks = topics
    .map(t => `<li><a href="${sanitizeFilename(t.title)}.html">${escapeHtml(t.title)}</a></li>`)
    .join('\n    ');

  zip.file('index.html', `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>${escapeHtml(helpTitle)}</title>
<style>body{font-family:sans-serif;max-width:700px;margin:2rem auto;padding:0 1rem}
li{margin:.3rem 0}a{color:#2563eb}</style></head>
<body><h1>${escapeHtml(helpTitle)}</h1><ul>
    ${indexLinks}
</ul></body></html>`);

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function buildSingleHtml(topics, helpTitle) {
  const sections = topics.map(t =>
    `<section id="topic-${t.index}">
      <h2>${escapeHtml(t.title)}</h2>
      ${renderTopic(t)}
    </section>`
  ).join('\n');

  const nav = topics.map(t =>
    `<li><a href="#topic-${t.index}">${escapeHtml(t.title)}</a></li>`
  ).join('\n');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(helpTitle)}</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; margin: 0; }
    nav  { width: 220px; flex-shrink: 0; border-right: 1px solid #dde1ea;
           height: 100vh; overflow-y: auto; position: sticky; top: 0;
           padding: 1rem; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li { margin: .3rem 0; }
    nav a  { color: #2563eb; text-decoration: none; font-size: .9rem; }
    main { flex: 1; padding: 2rem; max-width: 800px; }
    section { margin-bottom: 3rem; }
    hr { border: none; border-top: 1px solid #dde1ea; }
    pre { background: #f5f6fa; border: 1px solid #dde1ea; border-radius: 6px;
          padding: .8rem; overflow-x: auto; }
  </style>
</head>
<body>
  <nav><h3 style="margin:0 0 .8rem">${escapeHtml(helpTitle)}</h3>
    <ul>${nav}</ul>
  </nav>
  <main>${sections}</main>
</body>
</html>`;

  return new Blob([html], { type: 'text/html' });
}

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 80) || 'topico';
}

if (typeof module !== 'undefined') {
  module.exports = { renderTopic, buildDownloadPage, buildZip, escapeHtml };
}
