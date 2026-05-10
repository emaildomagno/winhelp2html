'use strict';

/**
 * Lightweight in-page debug logger.
 * Call DebugLog.info/ok/warn/error/head/dim from anywhere.
 * The panel appears automatically after the first message.
 */
const DebugLog = (() => {
  const MAX_LINES = 2000;
  let lines  = [];
  let _el    = null;
  let _badge = null;
  let _section = null;
  let warnCount = 0;

  function el()    { return _el      || (_el      = document.getElementById('debug-log')); }
  function badge() { return _badge   || (_badge   = document.getElementById('debug-badge')); }
  function sect()  { return _section || (_section = document.getElementById('debug-section')); }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function append(cls, msg) {
    if (lines.length >= MAX_LINES) return;
    lines.push({ cls, msg });

    const now   = new Date();
    const ts    = `${String(now.getMinutes()).padStart(2,'0')}:` +
                  `${String(now.getSeconds()).padStart(2,'0')}.` +
                  `${String(now.getMilliseconds()).padStart(3,'0')}`;

    const span  = document.createElement('span');
    span.className = `log-${cls}`;
    span.textContent = `[${ts}] ${msg}\n`;

    el().appendChild(span);

    /* Auto-scroll to bottom if already at bottom */
    const logEl = el();
    if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60) {
      logEl.scrollTop = logEl.scrollHeight;
    }

    /* Update badge */
    badge().textContent = `${lines.length} entr${lines.length === 1 ? 'ada' : 'adas'}`;
    if (cls === 'warn' || cls === 'error') {
      warnCount++;
      badge().classList.add('has-warn');
    }

    /* Show the panel */
    sect().classList.remove('hidden');
  }

  function clear() {
    lines     = [];
    warnCount = 0;
    if (_el)      _el.innerHTML      = '';
    if (_badge)   { _badge.textContent = '0 entradas'; _badge.classList.remove('has-warn'); }
    if (_section) _section.classList.add('hidden');
  }

  function copyToClipboard() {
    const text = lines.map(l => l.msg).join('\n');
    navigator.clipboard?.writeText(text).catch(() => {
      /* fallback */
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  /* Wire up copy button once DOM is ready */
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-copy-log');
    if (btn) btn.addEventListener('click', e => { e.stopPropagation(); copyToClipboard(); });
  });

  return {
    clear,
    info:  msg => append('info',  msg),
    ok:    msg => append('ok',    msg),
    warn:  msg => append('warn',  msg),
    error: msg => append('error', msg),
    head:  msg => append('head',  msg),
    dim:   msg => append('dim',   msg),

    /* Dump a hex preview of a byte range (max 32 bytes) */
    hex(label, buf, offset, length = 32) {
      const bytes = new Uint8Array(buf, offset, Math.min(length, buf.byteLength - offset));
      const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      append('dim', `${label}: [${hex}]`);
    },
  };
})();
