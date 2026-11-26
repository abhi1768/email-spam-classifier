(() => {
'use strict';

/* ===== Config ===== */
const HISTORY_KEY = 'mg_history', THEME_KEY = 'mg_theme', MAX_HISTORY = 25, MAX_FILE = 1024 * 1024;
const SLIDE_INTERVAL_MS = 3000;
const LABELS = ['Spam', 'Suspicious', 'Legitimate'];
const VERDICT = { Spam: 'Likely Spam', Suspicious: 'Suspicious', Legitimate: 'Legitimate' };
const SAMPLES = {
  phishing: 'URGENT: Your account has been suspended!!! Verify your password immediately at http://secure-login.example-verify.com/account or your bank access will be permanently closed within 24 hours. ACT NOW.',
  prize: 'CONGRATULATIONS!!! You are the WINNER of a $1,000,000 lottery! Claim your free gift card and cash prize now: http://claim-prize.example.biz/win Send your bank details today!',
  work: 'Hi team,\n\nThanks for joining the planning call today. I have attached the meeting notes and the updated project timeline. Please review before Thursday and send me any comments.\n\nBest,\nPriya'
};

/* ===== State (single source of truth shared by all tabs) ===== */
const state = { gmail: [], gmFilter: 'All', hiFilter: 'All', lastText: { paste: '', file: '' }, lastReport: { paste: '', file: '' }, fileText: '' };

/* ===== Utils ===== */
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lc = (s) => String(s || '').toLowerCase();
const countLinks = (t) => (t.match(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi) || []).length;
const fmtSize = (b) => (b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB');
const snippetOf = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140);
let toastTimer;
function toast(msg, isErr) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}
function store(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }

/* ===== Theme ===== */
function initTheme() {
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  });
}

/* ===== Tabs ===== */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach((p) => {
    const on = p.id === 'tab-' + name;
    p.hidden = !on; p.classList.toggle('active', on);
  });
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
}
function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); showTab(n.dataset.tab);
    });
  });
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
}

/* ===== Home Banner Slider ===== */
function initSlider() {
  const slider = $('heroSlider'), track = $('heroTrack');
  if (!slider || !track) return;
  const slides = [...slider.querySelectorAll('.hero-slide')];
  const dots = [...slider.querySelectorAll('.hero-dot')];
  let idx = 0, timer = null, startX = 0;

  function goTo(n) {
    idx = (n + dots.length) % dots.length;
    track.style.transform = 'translateX(-' + (idx * 50) + '%)';
    slides.forEach((s, i) => {
      s.classList.remove('is-active');
      if (i === idx) { void s.offsetWidth; s.classList.add('is-active'); }
    });
    dots.forEach((d, i) => {
      const on = i === idx;
      d.classList.toggle('active', on);
      d.setAttribute('aria-selected', on);
    });
  }
  function start() {
    stop();
    timer = setInterval(() => goTo(idx + 1), SLIDE_INTERVAL_MS);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  dots.forEach((d, i) => d.addEventListener('click', () => { goTo(i); start(); }));
  slider.addEventListener('mouseenter', stop);
  slider.addEventListener('mouseleave', start);
  slider.addEventListener('focusin', stop);
  slider.addEventListener('focusout', start);
  slider.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; stop(); }, { passive: true });
  slider.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) goTo(idx + (dx < 0 ? 1 : -1));
    start();
  }, { passive: true });

  start();
}

/* ===== API ===== */
async function api(url, opts) {
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new Error('Cannot reach the server. Is Flask running?'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}
async function checkHealth() {
  const b = $('apiBadge');
  try { const d = await api('/health'); const ok = d.status === 'ok'; b.className = 'badge api ' + (ok ? 'on' : 'off'); b.textContent = ok ? 'API Connected' : 'API Offline'; }
  catch (e) { b.className = 'badge api off'; b.textContent = 'API Offline'; }
}
const predict = (email) => api('/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });

/* ===== Signals (local heuristics) ===== */
function getSignals(text) {
  const out = [];
  const urgent = text.match(/\b(urgent|immediately|act now|final notice|expires?|suspended|within 24 hours|verify your|asap)\b/gi);
  const lure = text.match(/(\$\s?\d|\b(prize|winner|won|lottery|free|cash|gift card|claim|bank|password|inheritance)\b)/gi);
  const links = countLinks(text);
  const letters = text.replace(/[^a-z]/gi, ''), upper = letters.replace(/[^A-Z]/g, '');
  if (urgent) out.push('Urgency wording: ' + [...new Set(urgent.map(lc))].slice(0, 4).join(', '));
  if (lure) out.push('Financial or giveaway lure: ' + [...new Set(lure.map(lc))].slice(0, 4).join(', '));
  if (links) out.push(links + ' external link' + (links > 1 ? 's' : '') + ' found');
  if (letters.length > 20 && upper.length / letters.length > 0.3) out.push('High uppercase ratio (' + Math.round((upper.length / letters.length) * 100) + '%)');
  if (/[!?]{2,}/.test(text)) out.push('Repeated punctuation (!! or ??)');
  return out;
}

/* ===== Render ===== */
const verdictClass = (l) => lc(l);
function pill(label, conf) { return '<span class="badge v-' + verdictClass(label) + '">' + escapeHtml(VERDICT[label] || label) + ' · ' + Number(conf).toFixed(1) + '%</span>'; }
function renderResult(target, r, text) {
  const sig = getSignals(text);
  const el = $(target);
  el.innerHTML =
    '<span class="verdict v-' + verdictClass(r.label) + '">' + escapeHtml(VERDICT[r.label] || r.label) + '</span>' +
    '<div class="gauge"><i class="f-' + verdictClass(r.label) + '"></i></div>' +
    '<p class="muted small">Model confidence: <b>' + Number(r.confidence).toFixed(1) + '%</b></p>' +
    '<h3>Detected text signals</h3>' +
    (sig.length ? '<ul class="signals">' + sig.map((s) => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>' : '<p class="muted">No suspicious text signals found.</p>') +
    '<button class="btn" type="button" data-copy="' + target + '">Copy report</button>';
  requestAnimationFrame(() => requestAnimationFrame(() => { const g = el.querySelector('.gauge i'); if (g) g.style.width = Math.min(100, Number(r.confidence)) + '%'; }));
  const key = target === 'resultFile' ? 'file' : 'paste';
  state.lastReport[key] = 'MailGuard Report\nVerdict: ' + (VERDICT[r.label] || r.label) + '\nConfidence: ' + Number(r.confidence).toFixed(1) + '%\nSignals: ' + (sig.length ? sig.join('; ') : 'none') + '\nPreview: ' + snippetOf(text);
}
const loading = (target) => { $(target).innerHTML = '<div class="spinner" role="status" aria-label="Inspecting"></div>'; };
const emptyResult = (target, msg) => { $(target).innerHTML = '<p class="empty">' + escapeHtml(msg) + '</p>'; };

/* ===== Inspect (one function used by every tab) ===== */
async function inspect(text, source, target, preset) {
  text = (text || '').trim();
  if (!text) { toast('Add some email text first.', true); return; }
  loading(target);
  try {
    const r = preset || await predict(text);
    renderResult(target, r, text);
    addHistory(text, r, source);
  } catch (e) { emptyResult(target, e.message); toast(e.message, true); }
}

/* ===== History store ===== */
const getHistory = () => { const h = store(HISTORY_KEY, []); return Array.isArray(h) ? h : []; };
function addHistory(text, r, source) {
  const h = getHistory();
  h.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), text, snippet: snippetOf(text), label: r.label, confidence: Number(r.confidence), source, timestamp: new Date().toISOString() });
  save(HISTORY_KEY, h.slice(0, MAX_HISTORY));
  renderHome();
}

/* ===== Generic filter pills with live counts ===== */
function renderPills(elId, items, active, onPick) {
  const el = $(elId);
  el.innerHTML = ['All', ...LABELS].map((f) => {
    const n = f === 'All' ? items.length : items.filter((i) => i.label === f).length;
    return '<button class="chip' + (f === active ? ' on' : '') + '" data-f="' + f + '" type="button">' + f + ' (' + n + ')</button>';
  }).join('');
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.f)));
}

/* ===== Home ===== */
function countUp(id, to) {
  const el = $(id), from = Number(el.textContent) || 0;
  if (from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  (function step(t) { const p = Math.min(1, (t - t0) / 600); el.textContent = Math.round(from + (to - from) * p); if (p < 1) requestAnimationFrame(step); })(t0);
}
function renderHome() {
  const h = getHistory();
  countUp('stTotal', h.length);
  countUp('stSpam', h.filter((i) => i.label === 'Spam').length);
  countUp('stSusp', h.filter((i) => i.label === 'Suspicious').length);
  countUp('stLegit', h.filter((i) => i.label === 'Legitimate').length);
}
function initSamples() {
  document.querySelectorAll('.sample').forEach((b) => b.addEventListener('click', () => openInPaste(SAMPLES[b.dataset.sample], 'sample', true)));
}

/* ===== Paste ===== */
function updateCounters() {
  const t = $('emailText').value;
  $('cWords').textContent = (t.trim().match(/\S+/g) || []).length;
  $('cChars').textContent = t.length;
  $('cLinks').textContent = countLinks(t);
}
function openInPaste(text, source, run, preset) {
  $('emailText').value = text; updateCounters(); showTab('paste');
  if (run) inspect(text, source, 'resultPaste', preset); else emptyResult('resultPaste', 'Press Inspect email to analyze this text.');
}
function initPaste() {
  const ta = $('emailText');
  ta.addEventListener('input', updateCounters);
  ta.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('inspectBtn').click(); } });
  $('inspectBtn').addEventListener('click', async () => { const b = $('inspectBtn'); b.disabled = true; await inspect(ta.value, 'paste', 'resultPaste'); b.disabled = false; });
  $('clearBtn').addEventListener('click', () => { ta.value = ''; updateCounters(); emptyResult('resultPaste', 'Your verdict will appear here.'); ta.focus(); });
  document.body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const rep = state.lastReport[b.dataset.copy === 'resultFile' ? 'file' : 'paste'];
    try { await navigator.clipboard.writeText(rep); toast('Report copied.'); } catch (err) { toast('Copy failed. Select the text manually.', true); }
  });
}

/* ===== File ===== */
function handleFile(file) {
  if (!file) return;
  if (!/\.(txt|eml)$/i.test(file.name)) { toast('Only .txt and .eml files are supported.', true); return; }
  if (file.size > MAX_FILE) { toast('File is larger than 1 MB.', true); return; }
  const rd = new FileReader();
  rd.onerror = () => toast('Could not read that file.', true);
  rd.onload = () => {
    const text = String(rd.result || '');
    state.fileText = text;
    $('fName').textContent = file.name;
    $('fMeta').textContent = fmtSize(file.size) + ' · ' + text.length + ' characters';
    $('fileInfo').hidden = false;
    inspect(text, 'file', 'resultFile');
  };
  rd.readAsText(file);
}
function initFile() {
  const dz = $('dropZone'), fi = $('fileInput');
  $('pickBtn').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { handleFile(fi.files[0]); fi.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  $('editBtn').addEventListener('click', () => openInPaste(state.fileText, 'file', false));
}

/* ===== Gmail ===== */
function renderGmail() {
  const q = lc($('gmSearch').value.trim());
  renderPills('gmPills', state.gmail, state.gmFilter, (f) => { state.gmFilter = f; renderGmail(); });
  const rows = state.gmail.filter((m) => (state.gmFilter === 'All' || m.label === state.gmFilter) && (!q || lc(m.subject + ' ' + m.sender + ' ' + m.body).includes(q)));
  $('gmList').innerHTML = rows.length ? rows.map((m) => {
    const i = state.gmail.indexOf(m);
    return '<button class="item l-' + verdictClass(m.label) + '" type="button" data-i="' + i + '"><span class="top"><span class="subj">' + escapeHtml(m.subject || '(no subject)') + '</span>' + pill(m.label, m.confidence) + '</span><span class="meta">' + escapeHtml(m.sender) + '</span><span class="snip">' + escapeHtml(m.snippet) + '</span></button>';
  }).join('') : '<p class="none">' + (state.gmail.length ? 'No emails match your search or filter.' : 'Press Scan inbox to fetch your unread emails.') + '</p>';
}
async function scanInbox() {
  const b = $('scanBtn'); b.disabled = true; b.textContent = 'Scanning…';
  $('gmList').innerHTML = '<div class="spinner" role="status" aria-label="Scanning inbox"></div>';
  try {
    const d = await api('/scan-gmail?max_results=' + encodeURIComponent($('maxSel').value));
    state.gmail = Array.isArray(d.results) ? d.results : [];
    state.gmFilter = 'All'; renderGmail();
    toast(state.gmail.length ? state.gmail.length + ' emails scanned.' : 'No unread emails found.');
  } catch (e) { state.gmail = []; renderGmail(); $('gmList').innerHTML = '<p class="none">' + escapeHtml(e.message) + '</p>'; toast(e.message, true); }
  b.disabled = false; b.textContent = 'Scan inbox';
}
function initGmail() {
  $('scanBtn').addEventListener('click', scanInbox);
  $('gmSearch').addEventListener('input', renderGmail);
  $('gmList').addEventListener('click', (e) => {
    const c = e.target.closest('.item'); if (!c) return;
    const m = state.gmail[Number(c.dataset.i)]; if (!m) return;
    openInPaste(m.body || m.snippet || '', 'gmail', true, { label: m.label, confidence: m.confidence });
  });
  renderGmail();
}

/* ===== History tab ===== */
function renderHistory() {
  const h = getHistory(), q = lc($('hiSearch').value.trim());
  renderPills('hiPills', h, state.hiFilter, (f) => { state.hiFilter = f; renderHistory(); });
  const rows = h.filter((i) => (state.hiFilter === 'All' || i.label === state.hiFilter) && (!q || lc(i.text).includes(q)));
  $('hiList').innerHTML = rows.length ? rows.map((i) =>
    '<button class="item l-' + verdictClass(i.label) + '" type="button" data-id="' + escapeHtml(i.id) + '" title="Re-inspect"><span class="top"><span class="meta">' + escapeHtml(new Date(i.timestamp).toLocaleString()) + ' · ' + escapeHtml(i.source) + '</span>' + pill(i.label, i.confidence) + '</span><span class="snip">' + escapeHtml(i.snippet) + '</span><span class="meta">Click to re-inspect</span></button>'
  ).join('') : '<p class="none">' + (h.length ? 'No history matches your search or filter.' : 'No scans yet. Inspect an email to see it here.') + '</p>';
}
function initHistory() {
  $('hiSearch').addEventListener('input', renderHistory);
  $('hiClear').addEventListener('click', () => {
    if (!getHistory().length) return toast('History is already empty.');
    if (confirm('Clear all scan history? This cannot be undone.')) { save(HISTORY_KEY, []); renderHistory(); renderHome(); toast('History cleared.'); }
  });
  $('hiList').addEventListener('click', (e) => {
    const c = e.target.closest('.item'); if (!c) return;
    const it = getHistory().find((i) => i.id === c.dataset.id);
    if (it) openInPaste(it.text, 'history', true);
  });
}

/* ===== init ===== */
document.addEventListener('DOMContentLoaded', () => {
  initTheme(); initTabs(); initSlider(); initSamples(); initPaste(); initFile(); initGmail(); initHistory();
  emptyResult('resultPaste', 'Your verdict will appear here.');
  emptyResult('resultFile', 'Upload a file to see its verdict.');
  renderHome(); renderHistory(); checkHealth();
});
})();