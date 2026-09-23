/**
 * The one page `thread answer` opens (home-base-p1uj.12).
 *
 * A single static HTML document with no framework and no CDN — the spike verdict
 * on the bead is that the mature multi-line editor this feature needs is the
 * browser's own `<textarea>`, and pulling a UI library in behind it would undo
 * the reason the web option won.
 *
 * THREE THINGS ABOUT THIS FILE ARE LOAD-BEARING, not style:
 *
 * 1. THERE IS NO `<form>`. Not an oversight — a form gives Enter an implicit
 *    submit target, which is the class of accident invariant I3 exists to
 *    prevent. Every write goes through an explicit handler.
 * 2. THE KEY MAP IS INLINED FROM `answer-keymap.ts` VIA `.toString()`, so the
 *    page and the test suite run the same function rather than two copies that
 *    drift.
 * 3. A FAILED AUTOSAVE IS RED AND SAYS SO. "saved", "saving", and "NOT SAVED"
 *    are three states with three renderings; a save that errored must never
 *    settle back into the reassuring one (rule 6). The whole feature is a
 *    promise that text on screen is text on disk, and the indicator is where
 *    that promise is either kept or quietly broken.
 */

import {keyActionFor, KEYMAP_FOOTER} from './answer-keymap';
import {htmlFromReportText} from './render-html';

/** One ask, as the page needs it. Mirrors `AskView` plus its stored draft. */
export interface PageAsk {
  defaultAction: string;
  description: string;
  /** The draft already on disk for this ask, or null when there is none. */
  draft: string | null;
  id: string;
  kind: string;
  /** 1-based, matching the number this ask carried in the report. */
  number: number;
  optionCount: number;
  /** 0-4 (D15). P0 is the old `blocking`. */
  priority: number;
  reportCount: number | null;
  title: string;
}

export interface PageData {
  asks: PageAsk[];
  /** The note's draft, or null. */
  noteDraft: string | null;
  /** The reserved id the final free-text note is stored under (I7). */
  noteId: string;
  /** Anything that went wrong READING the drafts — shown, never swallowed. */
  problems: string[];
  /** The rendered status report from the thread bead (D10). */
  report: string;
  threadId: string;
  threadTitle: string;
  token: string;
}

/** JSON that cannot close the script tag it is embedded in. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fbfaf8; --fg:#1b1a18; --muted:#6a6862; --line:#dcd8d0; --card:#fff; --accent:#2f5d9e; --warn:#a4491c; --bad:#a3182a; --ok:#2c6b41; }
@media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e6e1; --muted:#9a978f; --line:#333538; --card:#1e2023; --accent:#84b0ee; --warn:#e29b6b; --bad:#f08a96; --ok:#7dc79b; } }
* { box-sizing: border-box; }
/* Load-bearing, and found by looking at a real render rather than at the markup:
   .overlay sets display:flex, which outranks the [hidden] attribute's own
   display:none, so BOTH overlays were open on page load — the review panel
   covering the asks before a single key had been pressed. */
[hidden] { display: none !important; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding-bottom:64px; }
header { padding:20px 20px 8px; border-bottom:1px solid var(--line); }
h1 { font-size:17px; margin:0 0 4px; }
.sub { color:var(--muted); font-size:13px; }
main { max-width:860px; margin:0 auto; padding:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:24px 0; }
.card.focus { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.card.skipped { opacity:.62; }
.tag { display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; padding:2px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); margin-right:6px; }
.tag.blocking { color:var(--warn); border-color:var(--warn); }
.askbody { white-space:pre-wrap; margin:12px 0 14px; line-height:1.8; }
textarea { width:100%; min-height:132px; resize:vertical; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
textarea:focus { outline:2px solid var(--accent); outline-offset:1px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px; }
button { font:inherit; padding:6px 12px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.state { font-size:12px; margin-left:auto; }
.state.saved { color:var(--ok); }
.state.saving { color:var(--muted); }
.state.bad { color:var(--bad); font-weight:700; }
.resumed { font-size:12px; color:var(--warn); margin-bottom:6px; }
footer { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--line); padding:8px 14px; font-size:12px; color:var(--muted); }
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:20px; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; max-width:620px; width:100%; max-height:80vh; overflow:auto; }
.panel h2 { margin:0 0 10px; font-size:16px; }
.panel li { margin:5px 0; }
details.report { margin:10px 0; }
/* The report panel used to be one <pre> with nothing marking the P0 Justin was
   meant to look at. It now goes through the shared html renderer (D14), so the
   same priority classes the terminal colours are available here. */
.report { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; font-size:13px; line-height:1.5; overflow:auto; }
.report h3 { margin:14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.report p { margin:3px 0; }
.report ul { margin:3px 0 3px 18px; padding:0; }
.report hr { border:0; border-top:1px solid var(--line); margin:10px 0; }
.report .glance { font-weight:700; font-size:14px; }
.report .where { color:var(--muted); font-size:12px; }
.report .ask, .report .askdetail { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
.report .ask { margin:18px 0 6px; }
.report .askdetail { padding-left:18px; margin:8px 0; }
.report li { margin:8px 0; }
.report .p0 { color:var(--bad); font-weight:600; }
.report .p3, .report .p4 { color:var(--muted); }
.report .pUnknown { color:var(--warn); }
.problems { border:1px solid var(--bad); color:var(--bad); border-radius:8px; padding:10px 12px; margin:10px 0; font-size:13px; }
@media (max-width:520px){ main{padding:10px;} .card{padding:12px;} }
`;

/**
 * The page's own script.
 *
 * A template string rather than a separate asset because the whole server is one
 * process that must start in milliseconds and own no build step. `__KEYMAP__` is
 * replaced with the serialised `keyActionFor`.
 */
const SCRIPT = String.raw`
__KEYMAP__

const DATA = window.__ANSWER_DATA__;
const qs = '?t=' + encodeURIComponent(DATA.token);
const fields = new Map();
const skipped = new Set();
let current = 0;

function api(path, init) { return fetch(path + qs, init); }

function setState(el, cls, text) {
  el.className = 'state ' + cls;
  el.textContent = text;
}

/**
 * Persist one field. A failure is shown in red and STAYS red — the indicator is
 * the only thing standing between "I typed it" and "it is on disk".
 */
async function save(id) {
  const f = fields.get(id);
  if (!f) return;
  setState(f.state, 'saving', 'saving…');
  try {
    const res = await api('/api/draft/' + encodeURIComponent(id), {
      body: f.area.value,
      method: 'PUT',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));
    const body = await res.json();
    setState(f.state, 'saved', 'saved ' + new Date(body.savedAt).toLocaleTimeString());
  } catch (error) {
    setState(f.state, 'bad', 'NOT SAVED — ' + error.message);
  }
}

function scheduleSave(id) {
  const f = fields.get(id);
  if (!f) return;
  setState(f.state, 'saving', 'unsaved…');
  clearTimeout(f.timer);
  f.timer = setTimeout(function () { save(id); }, 200);
}

/** Last-ditch flush that survives the tab closing. sendBeacon is POST-only. */
function flushBeacon() {
  fields.forEach(function (f, id) {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/draft/' + encodeURIComponent(id) + qs, new Blob([f.area.value], {type: 'text/plain'}));
    }
  });
}

function focusAsk(index) {
  const cards = Array.from(document.querySelectorAll('.card[data-id]'));
  if (cards.length === 0) return;
  current = Math.max(0, Math.min(cards.length - 1, index));
  cards.forEach(function (c, i) { c.classList.toggle('focus', i === current); });
  const area = cards[current].querySelector('textarea');
  if (area) { area.focus(); }
  cards[current].scrollIntoView({behavior: 'smooth', block: 'center'});
}

function toggleSkip(id) {
  const card = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (!card) return;
  if (skipped.has(id)) { skipped.delete(id); } else { skipped.add(id); }
  card.classList.toggle('skipped', skipped.has(id));
  const btn = card.querySelector('.skipbtn');
  if (btn) { btn.textContent = (skipped.has(id) ? 'Un-skip — ' : 'Skip — ') + 'use the default: ' + btn.dataset.default; }
}

function openMenu() { document.getElementById('menu').hidden = false; document.getElementById('menu-resume').focus(); }
function closeMenu() { document.getElementById('menu').hidden = true; }

// RAW, not trimmed (home-base-p1uj.13). The server applies trimAnswerText, the
// same function the classic walk uses, so the two surfaces record identical
// bytes (I8) — and the leading indentation of a pasted code block survives,
// which a .trim() here would have eaten before it ever left the browser.
// blank() is only ever used to decide whether a field counts as answered; it is
// the same question trimAnswerText(x) === '' answers. (No backticks in this
// file's page script: it is a template literal, and one would end it.)
function blank(v) { return v.trim() === ''; }
function decisions() {
  return DATA.asks.map(function (a) {
    const f = fields.get(a.id);
    const text = f ? f.area.value : '';
    if (skipped.has(a.id) || blank(text)) return {askId: a.id, kind: 'skipped', text: ''};
    return {askId: a.id, kind: 'answered', text: text};
  });
}
// Display only: the review list shows the first line that has something on it.
function preview(t) {
  const lines = t.replace(/\s+$/, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = lines[i] === undefined ? '' : lines[i];
  return first.slice(0, 90) + (first.length > 90 || i + 1 < lines.length ? '…' : '');
}

function openReview() {
  const list = document.getElementById('review-list');
  list.innerHTML = '';
  decisions().forEach(function (d, i) {
    const a = DATA.asks[i];
    const li = document.createElement('li');
    li.textContent = (i + 1) + '. ' + a.id + ' — ' + (d.kind === 'skipped' ? 'SKIP, Claude will: ' + a.defaultAction : preview(d.text));
    list.appendChild(li);
  });
  const note = fields.get(DATA.noteId);
  document.getElementById('review-note').textContent = note && !blank(note.area.value) ? note.area.value : '(no note)';
  document.getElementById('review').hidden = false;
  document.getElementById('review-cancel').focus();
}
function closeReview() { document.getElementById('review').hidden = true; }

async function record() {
  const btn = document.getElementById('review-record');
  btn.disabled = true;
  btn.textContent = 'recording…';
  const note = fields.get(DATA.noteId);
  const res = await api('/api/submit', {
    body: JSON.stringify({decisions: decisions(), note: note ? note.area.value : ''}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  });
  const body = await res.json();
  const panel = document.getElementById('review-panel');
  panel.innerHTML = '<h2>' + (body.failures.length === 0 ? 'Recorded.' : 'Some answers did NOT reach bd') + '</h2>' +
    '<p>' + body.summary + '</p>' +
    (body.failures.length ? '<ul>' + body.failures.map(function (f) { return '<li>' + f.label + ' — ' + f.detail + '</li>'; }).join('') + '</ul>' : '') +
    '<p>Your drafts are ' + (body.draftsKept ? 'still on disk.' : 'cleared — everything was recorded.') + '</p>' +
    '<p><strong>Tell Claude: answers in</strong></p><p>You can close this tab.</p>';
}

function onKey(event) {
  const inTextarea = event.target && event.target.tagName === 'TEXTAREA';
  const action = keyActionFor({
    altKey: event.altKey, ctrlKey: event.ctrlKey, inTextarea: inTextarea,
    key: event.key, metaKey: event.metaKey, shiftKey: event.shiftKey,
  });
  if (action === 'newline' || action === 'none') return; // the browser's job
  if (action === 'menu') {
    event.preventDefault();
    if (!document.getElementById('review').hidden) { closeReview(); return; }
    if (document.getElementById('menu').hidden) { openMenu(); } else { closeMenu(); }
    return;
  }
  if (action === 'submit') { event.preventDefault(); closeMenu(); openReview(); return; }
  if (action === 'skip') {
    event.preventDefault();
    const card = event.target.closest ? event.target.closest('.card[data-id]') : null;
    const id = card ? card.dataset.id : (DATA.asks[current] || {}).id;
    if (id && id !== DATA.noteId) toggleSkip(id);
    return;
  }
  if (action === 'next') { event.preventDefault(); focusAsk(current + 1); return; }
  if (action === 'prev') { event.preventDefault(); focusAsk(current - 1); }
}

function wire() {
  document.querySelectorAll('textarea[data-id]').forEach(function (area) {
    const id = area.dataset.id;
    fields.set(id, {area: area, state: document.querySelector('.state[data-for="' + CSS.escape(id) + '"]'), timer: 0});
    area.addEventListener('input', function () { scheduleSave(id); });
    area.addEventListener('blur', function () { save(id); });
    area.addEventListener('focus', function () {
      const cards = Array.from(document.querySelectorAll('.card[data-id]'));
      const card = area.closest('.card[data-id]');
      if (card) focusAsk(cards.indexOf(card));
    });
  });
  document.querySelectorAll('.skipbtn').forEach(function (b) {
    b.addEventListener('click', function () { toggleSkip(b.dataset.id); });
  });
  document.querySelectorAll('.discardbtn').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Discard the saved draft for ' + b.dataset.id + '? This is the only thing here that deletes text.')) return;
      await api('/api/discard/' + encodeURIComponent(b.dataset.id), {method: 'POST'});
      const f = fields.get(b.dataset.id);
      if (f) { f.area.value = ''; setState(f.state, 'saved', 'draft discarded'); }
    });
  });
  document.getElementById('submitbtn').addEventListener('click', openReview);
  document.getElementById('menu-resume').addEventListener('click', closeMenu);
  document.getElementById('menu-submit').addEventListener('click', function () { closeMenu(); openReview(); });
  document.getElementById('menu-quit').addEventListener('click', async function () {
    flushBeacon();
    await api('/api/quit', {method: 'POST'});
    document.body.innerHTML = '<main><h1>Stopped. Every draft is still on disk.</h1><p>Run <code>bun run justin-sdk thread answer</code> again to pick up exactly where you left off.</p></main>';
  });
  document.getElementById('review-cancel').addEventListener('click', closeReview);
  document.getElementById('review-record').addEventListener('click', record);
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', flushBeacon);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushBeacon(); });
  focusAsk(0);
}

wire();
`;

function askCard(ask: PageAsk): string {
  const id = escapeHtml(ask.id);
  const body = escapeHtml(ask.description === '' ? ask.title : ask.description);
  const from =
    ask.reportCount == null
      ? ''
      : `<span class="tag">from report #${ask.reportCount}</span>`;
  const resumed =
    ask.draft == null
      ? ''
      : `<div class="resumed">Resumed: ${ask.draft.length} characters were waiting on disk from a previous run.</div>`;
  const discard =
    ask.draft == null
      ? ''
      : `<button class="discardbtn" data-id="${id}" type="button">Discard saved draft</button>`;
  return `
  <section class="card" data-id="${id}">
    <div>
      <span class="tag">${ask.number}</span>
      <span class="tag ${ask.priority === 0 ? 'blocking' : ''}">${ask.priority === 0 ? '🛑 P0' : `P${ask.priority}`}</span>
      <span class="tag">${escapeHtml(ask.kind)}</span>
      ${from}
      <span class="tag">${id}</span>
    </div>
    <div class="askbody">${body}</div>
    ${resumed}
    <textarea aria-label="Answer for ${id}" data-id="${id}" spellcheck="true">${escapeHtml(ask.draft ?? '')}</textarea>
    <div class="row">
      <button class="skipbtn" data-default="${escapeHtml(ask.defaultAction)}" data-id="${id}" type="button">Skip — use the default: ${escapeHtml(ask.defaultAction)}</button>
      ${discard}
      <span class="state saved" data-for="${id}">on disk</span>
    </div>
  </section>`;
}

/** The whole document. Pure: same data in, same bytes out — so a test can read it. */
export function renderAnswerPage(data: PageData): string {
  const cards = data.asks.map((ask) => askCard(ask)).join('\n');
  const problems =
    data.problems.length === 0
      ? ''
      : `<div class="problems"><strong>Could not read some drafts — this is NOT "there are none":</strong><ul>${data.problems
          .map((problem) => `<li>${escapeHtml(problem)}</li>`)
          .join('')}</ul></div>`;
  const noteDraft = escapeHtml(data.noteDraft ?? '');
  const noteResumed =
    data.noteDraft == null
      ? ''
      : `<div class="resumed">Resumed: ${data.noteDraft.length} characters were waiting on disk.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1" name="viewport">
<title>Answer ${escapeHtml(data.threadId)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(data.threadTitle)}</h1>
  <div class="sub">${escapeHtml(data.threadId)} · ${data.asks.length} open ask${data.asks.length === 1 ? '' : 's'} · nothing is written to bd until you press Record</div>
</header>
<main>
  ${problems}
  <details>
    <summary>The report this came from</summary>
    ${htmlFromReportText(data.report)}
  </details>
  ${cards}
  <section class="card" data-id="${escapeHtml(data.noteId)}">
    <div><span class="tag">note</span><span class="tag">optional</span></div>
    <div class="askbody">Anything else for Claude?</div>
    ${noteResumed}
    <textarea aria-label="Note for Claude" data-id="${escapeHtml(data.noteId)}" spellcheck="true">${noteDraft}</textarea>
    <div class="row"><span class="state saved" data-for="${escapeHtml(data.noteId)}">on disk</span></div>
  </section>
  <div class="row"><button class="primary" id="submitbtn" type="button">Review &amp; submit (Ctrl/Cmd-S)</button></div>
</main>

<div class="overlay" hidden id="menu">
  <div class="panel">
    <h2>Menu</h2>
    <p>Esc opens this. It never quits and never discards anything.</p>
    <div class="row">
      <button id="menu-resume" type="button">Resume answering</button>
      <button id="menu-submit" type="button">Review &amp; submit all</button>
      <button id="menu-quit" type="button">Quit, keeping every draft</button>
    </div>
  </div>
</div>

<div class="overlay" hidden id="review">
  <div class="panel" id="review-panel">
    <h2>About to record</h2>
    <ol id="review-list"></ol>
    <p><strong>Note:</strong> <span id="review-note"></span></p>
    <div class="row">
      <button id="review-cancel" type="button">Cancel — go back</button>
      <button class="primary" id="review-record" type="button">Record these answers</button>
    </div>
  </div>
</div>

<footer>${escapeHtml(KEYMAP_FOOTER)}</footer>
<script>window.__ANSWER_DATA__ = ${safeJson(data)};</script>
<script>${SCRIPT.replace('__KEYMAP__', keyActionFor.toString())}</script>
</body>
</html>`;
}
