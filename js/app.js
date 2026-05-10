'use strict';

/* ─────────────────────────────────────────────
   DOM references
───────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const dropZone        = $('drop-zone');
const fileInput       = $('file-input');
const progressSection = $('progress-section');
const progressBar     = $('progress-bar');
const progressLabel   = $('progress-label');
const errorSection    = $('error-section');
const errorMessage    = $('error-message');
const errorRetry      = $('error-retry');
const resultSection   = $('result-section');
const resultTitle     = $('result-title');
const resultCount     = $('result-count');
const btnDownloadAll  = $('btn-download-all');
const btnReset        = $('btn-reset');
const topicList       = $('topic-list');
const navSearch       = $('nav-search');
const contentTitle    = $('content-title');
const contentBody     = $('content-body');
const btnDownloadTopic= $('btn-download-topic');

/* ─────────────────────────────────────────────
   State
───────────────────────────────────────────── */
let parsedData    = null;
let activeIndex   = -1;
let filteredTopics = [];

/* ─────────────────────────────────────────────
   UI helpers
───────────────────────────────────────────── */
function showOnly(section) {
  for (const s of [dropZone, progressSection, errorSection, resultSection]) {
    s.classList.toggle('hidden', s !== section);
  }
}

function setProgress(pct, label) {
  progressBar.style.width = `${pct}%`;
  progressLabel.textContent = label;
}

function showError(msg) {
  errorMessage.textContent = msg;
  showOnly(errorSection);
}

/* ─────────────────────────────────────────────
   File handling
───────────────────────────────────────────── */
function handleFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.hlp')) {
    showError(`Arquivo inválido: "${file.name}". Selecione um arquivo .hlp do WinHelp.`);
    showOnly(errorSection);
    return;
  }

  showOnly(progressSection);
  setProgress(5, 'Carregando arquivo…');

  const reader = new FileReader();

  reader.onload = e => {
    const buffer = e.target.result;
    parseAsync(buffer);
  };

  reader.onerror = () => showError('Falha ao ler o arquivo.');
  reader.readAsArrayBuffer(file);
}

async function parseAsync(buffer) {
  try {
    const result = await new Promise((resolve, reject) => {
      /* Run in a microtask so the progress bar can paint first */
      setTimeout(() => {
        try {
          resolve(parseHLP(buffer, (pct, label) => {
            setProgress(pct, label);
          }));
        } catch (e) {
          reject(e);
        }
      }, 30);
    });

    setProgress(100, 'Concluído!');
    parsedData = result;

    /* Brief pause so the user sees 100% */
    setTimeout(() => renderResult(result), 300);

  } catch (e) {
    showError(e.message || 'Erro desconhecido ao processar o arquivo.');
    showOnly(errorSection);
  }
}

/* ─────────────────────────────────────────────
   Result rendering
───────────────────────────────────────────── */
function renderResult(data) {
  resultTitle.textContent = data.title;
  resultCount.textContent = `${data.topics.length} tópico${data.topics.length !== 1 ? 's' : ''}`;

  filteredTopics = data.topics;
  renderTopicList(filteredTopics);

  /* Select first topic automatically */
  if (filteredTopics.length > 0) selectTopic(filteredTopics[0]);

  showOnly(resultSection);
}

function renderTopicList(topics) {
  topicList.innerHTML = '';

  if (topics.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<span style="padding:.6rem .9rem;display:block;color:var(--text-muted);font-size:.85rem">Nenhum resultado</span>';
    topicList.appendChild(li);
    return;
  }

  for (const topic of topics) {
    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.dataset.index = topic.index;
    btn.innerHTML =
      `${escapeHtml(topic.title)}<span class="topic-index">#${topic.index + 1}</span>`;
    btn.addEventListener('click', () => selectTopic(topic));
    li.appendChild(btn);
    topicList.appendChild(li);
  }
}

function selectTopic(topic) {
  activeIndex = topic.index;

  /* Highlight active in sidebar */
  for (const btn of topicList.querySelectorAll('button')) {
    btn.classList.toggle('active', parseInt(btn.dataset.index) === activeIndex);
  }

  contentTitle.textContent = topic.title;
  contentBody.innerHTML    = renderTopic(topic);
  btnDownloadTopic.classList.remove('hidden');

  /* Scroll sidebar item into view */
  const active = topicList.querySelector('button.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ─────────────────────────────────────────────
   Search
───────────────────────────────────────────── */
navSearch.addEventListener('input', () => {
  const q = navSearch.value.trim().toLowerCase();
  if (!parsedData) return;

  filteredTopics = q
    ? parsedData.topics.filter(t =>
        t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q))
    : parsedData.topics;

  renderTopicList(filteredTopics);

  /* Re-highlight active if still visible */
  if (activeIndex >= 0) {
    const btn = topicList.querySelector(`button[data-index="${activeIndex}"]`);
    if (btn) btn.classList.add('active');
  }
});

/* ─────────────────────────────────────────────
   Download
───────────────────────────────────────────── */
btnDownloadAll.addEventListener('click', async () => {
  if (!parsedData) return;
  btnDownloadAll.disabled = true;
  btnDownloadAll.textContent = '⏳ Gerando…';

  try {
    const blob = await buildZip(parsedData.topics, parsedData.title);
    downloadBlob(blob, sanitizeFilename(parsedData.title || 'winhelp') + '.zip');
  } finally {
    btnDownloadAll.disabled = false;
    btnDownloadAll.textContent = '⬇ Baixar ZIP';
  }
});

btnDownloadTopic.addEventListener('click', () => {
  if (!parsedData || activeIndex < 0) return;
  const topic = parsedData.topics.find(t => t.index === activeIndex);
  if (!topic) return;
  const html = buildDownloadPage(topic, parsedData.title);
  const blob = new Blob([html], { type: 'text/html' });
  downloadBlob(blob, sanitizeFilename(topic.title) + '.html');
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ─────────────────────────────────────────────
   Reset
───────────────────────────────────────────── */
function resetApp() {
  parsedData     = null;
  activeIndex    = -1;
  filteredTopics = [];
  fileInput.value = '';
  navSearch.value = '';
  contentBody.innerHTML = `<div class="placeholder-msg">
    <span>👈</span><p>Escolha um tópico na barra lateral para visualizá-lo.</p>
  </div>`;
  contentTitle.textContent = 'Selecione um tópico';
  btnDownloadTopic.classList.add('hidden');
  showOnly(dropZone);
}

btnReset.addEventListener('click', resetApp);
errorRetry.addEventListener('click', resetApp);

/* ─────────────────────────────────────────────
   Drop zone events
───────────────────────────────────────────── */
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

dropZone.addEventListener('click', e => {
  /* Don't trigger when clicking the label/button inside */
  if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') {
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

/* ─────────────────────────────────────────────
   Re-use helpers from hlp-renderer.js
───────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeFilename(name) {
  return (name || 'arquivo')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 80);
}
