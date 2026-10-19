/**
 * The page `thread dashboard --web` serves (home-base-yukaf.11, epic decision
 * D-WEB). Plain HTML and one inline script: no framework, no CDN, no asset
 * the server does not write itself.
 *
 * ONE RENDERER. The server renders the cards (`renderInboxHtml`) for the first
 * page AND for every refresh: `/api/state` carries the same fragment, and the
 * script swaps it in. The script never builds a card, so the page cannot drift
 * from what `curl` shows.
 *
 * EVERY BUTTON CARRIES ITS CARD'S IDS. A card holds `data-session-id`,
 * `data-bead-id` (absent for an untracked session) and `data-version`; a button
 * sends those three exactly as the card rendered them, and the server refuses
 * the action when any of them no longer matches the inbox it re-reads
 * (dashboard-web.ts). That is the guard against Justin's "I'm archiving one
 * session but the message gets mangled and it ends up deleting a different
 * session" (2026-10-17).
 */

import {escapeHtml} from './answer-page';
import {
  type DashboardAction,
  type DashboardInbox,
  type DashboardSession,
  planAction,
} from './dashboard-plan';
import {INBOX_SECTIONS} from './session-card';
import {sessionDisplayName} from './session-name';

const STYLE = `
:root { color-scheme: light dark; --bg:#fbfaf8; --fg:#1b1a18; --muted:#6a6862; --line:#dcd8d0; --card:#fff; --accent:#2f5d9e; --warn:#a4491c; --bad:#a3182a; --ok:#2c6b41; --code:#f1eee8; }
@media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e6e1; --muted:#9a978f; --line:#333538; --card:#1e2023; --accent:#84b0ee; --warn:#e29b6b; --bad:#f08a96; --ok:#7dc79b; --code:#26292d; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
header { position:sticky; top:0; z-index:2; background:var(--bg); padding:14px 16px 10px; border-bottom:1px solid var(--line); }
header .top { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; max-width:920px; margin:0 auto; }
h1 { font-size:17px; margin:0; }
.sub { color:var(--muted); font-size:13px; }
.grow { flex:1 1 auto; }
#status { max-width:920px; margin:8px auto 0; font-size:13px; white-space:pre-wrap; }
#status.ok { color:var(--ok); }
#status.bad { color:var(--bad); font-weight:600; }
main { max-width:920px; margin:0 auto; padding:8px 16px 48px; }
section h2 { font-size:15px; margin:28px 0 8px; }
section.all-only { display:none; }
body.show-all section.all-only { display:block; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
.card .title { font-weight:650; margin:0 0 2px; overflow-wrap:anywhere; }
.card .unread { color:var(--accent); margin-right:6px; }
.meta { color:var(--muted); font-size:13px; }
.need { margin:8px 0 0; }
.need b { font-weight:600; }
.draft { margin:8px 0 0; padding:8px 10px; border-left:3px solid var(--warn); white-space:pre-wrap; overflow-wrap:anywhere; }
code, .mono { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--code); border-radius:5px; padding:1px 5px; overflow-wrap:anywhere; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:10px; }
button { font:inherit; font-size:13px; padding:5px 11px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button:hover:not(:disabled) { border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; }
button.danger:hover:not(:disabled) { border-color:var(--bad); color:var(--bad); }
.result { font-size:12.5px; margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere; }
.result.ok { color:var(--ok); }
.result.bad { color:var(--bad); font-weight:600; }
details { margin-top:10px; }
summary { cursor:pointer; color:var(--accent); font-size:13px; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:8px 0 0; font-size:13px; }
dt { color:var(--muted); }
dd { margin:0; overflow-wrap:anywhere; }
ul.asked { margin:4px 0 0 18px; padding:0; }
.problems { max-width:920px; margin:12px auto 0; border:1px solid var(--bad); color:var(--bad); border-radius:8px; padding:8px 12px; font-size:13px; }
.empty { color:var(--muted); margin:24px 0; }
@media (max-width:560px) { header, main { padding-left:12px; padding-right:12px; } .card { padding:12px; } dl { grid-template-columns:1fr; } dt { margin-top:6px; } }
`;

/**
 * The page's script. Swaps in the server's fragment, sends actions, shows
 * the server's words. It renders nothing itself (see the file comment).
 */
const SCRIPT = String.raw`
const TOKEN = document.body.dataset.token;
const statusEl = document.getElementById('status');
const inboxEl = document.getElementById('inbox');
const refreshedEl = document.getElementById('refreshed');
let lastHtml = inboxEl.innerHTML;
let busy = 0;

function say(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function openDetails() {
  return new Set([...inboxEl.querySelectorAll('details[open]')].map((d) => d.dataset.key));
}

async function refresh() {
  let res;
  try {
    res = await fetch('/api/state?t=' + encodeURIComponent(TOKEN), {cache: 'no-store'});
  } catch (error) {
    say('Could not reach the dashboard server: ' + error.message + '. Is ' + location.host + ' still running?', 'bad');
    return;
  }
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok || body == null) {
    // Rule 7: a failed read is shown with its reason, and the cards on
    // screen stay as they were rather than turning into an empty page.
    say('The inbox could not be read (HTTP ' + res.status + '): ' + (body && body.error ? body.error : 'no reason given') + '. The cards below are from the last good read.', 'bad');
    return;
  }
  if (body.html !== lastHtml) {
    const open = openDetails();
    inboxEl.innerHTML = body.html;
    for (const d of inboxEl.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
    lastHtml = body.html;
  }
  refreshedEl.textContent = 'refreshed ' + new Date().toLocaleTimeString();
}

function cardOf(el) { return el.closest('[data-session-id]'); }

async function act(button) {
  const card = cardOf(button);
  if (card == null) return;
  const action = button.dataset.action;
  const name = card.dataset.name;
  if (action === 'archive' && !confirm('Archive ' + name + '?\n\nIt closes the session, its open requests and its open questions. ' + "Undo with: bun run justin-sdk thread unmark --session " + (card.dataset.beadId || card.dataset.sessionId))) return;
  if (action === 'done' && !confirm('Mark ' + name + ' done?\n\nUndo with: bun run justin-sdk thread unmark --session ' + (card.dataset.beadId || card.dataset.sessionId))) return;
  const result = card.querySelector('.result');
  const buttons = card.querySelectorAll('button[data-action]');
  buttons.forEach((b) => { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; });
  result.className = 'result';
  result.textContent = 'working…';
  busy += 1;
  let res = null;
  let body = null;
  try {
    res = await fetch('/api/action', {
      body: JSON.stringify({
        action,
        sessionBeadId: card.dataset.beadId === undefined ? null : card.dataset.beadId,
        sessionId: card.dataset.sessionId,
        stateVersion: card.dataset.version,
        token: TOKEN,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    });
    try { body = await res.json(); } catch (_) { body = null; }
  } catch (error) {
    body = {error: 'Could not reach the dashboard server: ' + error.message};
  }
  busy -= 1;
  buttons.forEach((b) => { b.disabled = b.dataset.wasDisabled === '1'; });
  if (res != null && res.ok && body != null) {
    if (action === 'resumeCommand' && typeof body.text === 'string') {
      try { await navigator.clipboard.writeText(body.text); body.message += ' (copied)'; } catch (_) { body.message += ' (copy it from here)'; }
    }
    result.className = 'result ok';
    result.textContent = body.message;
    say(body.message, 'ok');
  } else {
    // The server's refusal, verbatim: it names what changed and that nothing ran.
    const text = body && body.error ? body.error : 'HTTP ' + (res ? res.status : '?') + ' with no reason in the reply';
    result.className = 'result bad';
    result.textContent = text;
    say(text, 'bad');
  }
  await refresh();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button != null && !button.disabled) act(button);
});

const showAll = document.getElementById('show-all');
function applyShowAll() { document.body.classList.toggle('show-all', showAll.checked); }
try { showAll.checked = localStorage.getItem('threads-dashboard-show-all') === '1'; } catch (_) {}
applyShowAll();
showAll.addEventListener('change', () => {
  applyShowAll();
  try { localStorage.setItem('threads-dashboard-show-all', showAll.checked ? '1' : '0'); } catch (_) {}
});

document.getElementById('quit').addEventListener('click', async () => {
  if (!confirm('Stop the dashboard server? This page stops working; run thread dashboard --web again for a new one.')) return;
  try {
    await fetch('/api/quit', {body: JSON.stringify({token: TOKEN}), headers: {'content-type': 'application/json'}, method: 'POST'});
    say('The server stopped. Close this tab.', 'ok');
  } catch (error) {
    say('Could not stop the server: ' + error.message, 'bad');
  }
});

// Every 10 s while the tab is visible and no action is in flight.
setInterval(() => { if (busy === 0 && document.visibilityState === 'visible') refresh(); }, 10000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
`;

/** The button label for each action the page offers. */
const LABEL: Record<DashboardAction, string> = {
  archive: 'Archive',
  done: 'Done',
  open: 'Open in cmux',
  read: 'Mark read',
  resumeCommand: 'Copy resume command',
  unread: 'Mark unread',
};

function button(action: DashboardAction, s: DashboardSession): string {
  const plan = planAction(action, s);
  const refused = plan.kind === 'refused';
  const danger = action === 'archive' || action === 'done' ? ' danger' : '';
  return `<button type="button" class="act${danger}" data-action="${action}"${refused ? ` disabled title="${escapeHtml(plan.reason)}"` : ''}>${LABEL[action]}</button>`;
}

function youAskedHtml(s: DashboardSession): string {
  const asked = s.card.youAsked;
  if (asked.kind === 'requests') {
    if (asked.requests.length === 0) return '<dd>no request filed</dd>';
    const items = asked.requests
      .map(
        (request) =>
          `<li>${escapeHtml(request.icon)} ${escapeHtml(request.title)}${request.stage == null ? '' : ` <span class="meta">(${escapeHtml(request.stage)}${request.nextStage == null ? '' : `, next ${escapeHtml(request.nextStage)}`})</span>`}</li>`,
      )
      .join('');
    return `<dd><ul class="asked">${items}</ul></dd>`;
  }
  const first =
    asked.firstMessage == null
      ? 'no message captured'
      : `“${asked.firstMessage}”`;
  const why =
    asked.kind === 'unknown' ? ` (requests unreadable: ${asked.reason})` : '';
  return `<dd>${escapeHtml(first + why)}</dd>`;
}

function detailsHtml(s: DashboardSession): string {
  const rows: string[] = [];
  for (const fact of s.card.facts) {
    rows.push(
      `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`,
    );
  }
  rows.push(`<dt>You asked</dt>${youAskedHtml(s)}`);
  if (s.card.optional != null) {
    rows.push(
      `<dt>Optional</dt><dd>${escapeHtml(s.card.optional.text)} <code>${escapeHtml(s.card.optional.command)}</code></dd>`,
    );
  }
  rows.push(
    `<dt>Resume</dt><dd><code>${escapeHtml(s.card.resume)}</code></dd>`,
    `<dt>Pane</dt><dd>${s.card.pane == null ? 'not known: Open makes a new cmux workspace running the resume command' : `<code>${escapeHtml(s.card.pane)}</code>`}</dd>`,
    `<dt>Session</dt><dd><code>${escapeHtml(s.sessionId)}</code></dd>`,
    `<dt>Session bead</dt><dd>${s.sessionBeadId == null ? 'none (not tracked)' : `<code>${escapeHtml(s.sessionBeadId)}</code>`}</dd>`,
  );
  if (s.repeats != null && s.repeats > 1) {
    rows.push(
      `<dt>Folded</dt><dd>this line stands for ${s.repeats} sessions with the same first message; the buttons act on this one only</dd>`,
    );
  }
  return `<details data-key="${escapeHtml(s.sessionId)}"><summary>See more</summary><dl>${rows.join('')}</dl><div class="row">${button('resumeCommand', s)}</div></details>`;
}

/** One card. Its data attributes are what every button sends (file comment). */
export function renderCardHtml(s: DashboardSession): string {
  const name = sessionDisplayName(s.card.repoTag, s.card.title);
  const meta = [
    s.card.repoTag ?? s.repo ?? 'unknown repo',
    s.card.age,
    s.card.status,
  ]
    .filter((part): part is string => part != null && part !== '')
    .map((part) => escapeHtml(part))
    .join(' · ');
  const need =
    s.card.action.text === ''
      ? ''
      : `<p class="need"><b>You need to:</b> ${escapeHtml(s.card.action.text)}${s.card.action.command == null ? '' : ` <code>${escapeHtml(s.card.action.command)}</code>`}${
          // F1 (home-base-yukaf.14): unsent text is a second line.
          s.card.unsent == null
            ? ''
            : `<br>${escapeHtml(s.card.unsent.text)}${s.card.unsent.command == null ? '' : ` <code>${escapeHtml(s.card.unsent.command)}</code>`}`
        }</p>`;
  const draft =
    s.inputDraft == null
      ? ''
      : `<div class="draft"><b>You typed, never sent:</b>\n${escapeHtml(s.inputDraft)}</div>`;
  const readButton =
    s.unread === true ? button('read', s) : button('unread', s);
  const beadAttribute =
    s.sessionBeadId == null
      ? ''
      : ` data-bead-id="${escapeHtml(s.sessionBeadId)}"`;
  return [
    `<article class="card" data-session-id="${escapeHtml(s.sessionId)}"${beadAttribute} data-version="${escapeHtml(s.stateVersion)}" data-name="${escapeHtml(name)}">`,
    `<p class="title">${s.unread === true ? '<span class="unread" title="Claude wrote since you last marked it read">●</span>' : ''}${escapeHtml(name)}</p>`,
    `<div class="meta">${meta}</div>`,
    need,
    draft,
    `<div class="row">${button('open', s)}${readButton}${button('done', s)}${button('archive', s)}</div>`,
    '<div class="result" aria-live="polite"></div>',
    detailsHtml(s),
    '</article>',
  ].join('');
}

/**
 * The sections and their cards, in the inbox's section order, newest first
 * inside each (the order the inbox JSON already has). Done and Archived are
 * rendered but hidden until "Show Done and Archived" is ticked.
 */
export function renderInboxHtml(inbox: DashboardInbox): string {
  const parts: string[] = [];
  for (const problem of inbox.problems) {
    parts.push(`<div class="problems">${escapeHtml(problem)}</div>`);
  }
  let shown = 0;
  for (const section of INBOX_SECTIONS) {
    const sessions = inbox.sessions.filter((s) => s.section === section.key);
    if (sessions.length === 0) continue;
    if (!section.onlyWithAll) shown += sessions.length;
    parts.push(
      `<section data-section="${section.key}"${section.onlyWithAll ? ' class="all-only"' : ''}><h2>${escapeHtml(section.emoji)} ${escapeHtml(section.title)} (${sessions.length})</h2>${sessions.map(renderCardHtml).join('')}</section>`,
    );
  }
  if (shown === 0) {
    // Checked, and there are none: the read succeeded (a failed read never
    // reaches this function; the server answers 500 with its reason).
    parts.push(
      '<p class="empty">No open sessions in the inbox window. Tick "Show Done and Archived" for the finished ones.</p>',
    );
  }
  return parts.join('');
}

/** "3 Needs you · 1 To land · …" from the inbox's own summary counts. */
function summaryText(inbox: DashboardInbox): string {
  return inbox.summary
    .map((entry) => `${entry.emoji} ${entry.count} ${entry.title}`)
    .join(' · ');
}

export interface DashboardPageInput {
  /** The inbox, or why it could not be read (rule 7: never an empty page). */
  inbox: {failed: string} | {inbox: DashboardInbox};
  /** The CSP nonce the inline script carries. */
  nonce: string;
  token: string;
}

export function renderDashboardPage(input: DashboardPageInput): string {
  const body =
    'failed' in input.inbox
      ? `<div class="problems">The inbox could not be read: ${escapeHtml(input.inbox.failed)}. The page retries every 10 s.</div>`
      : renderInboxHtml(input.inbox.inbox);
  const summary = 'failed' in input.inbox ? '' : summaryText(input.inbox.inbox);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Threads dashboard</title>
<style>${STYLE}</style>
</head>
<body data-token="${escapeHtml(input.token)}">
<header>
<div class="top">
<h1>🧵 Threads</h1>
<span class="sub" id="summary">${escapeHtml(summary)}</span>
<span class="grow"></span>
<label class="sub"><input type="checkbox" id="show-all"> Show Done and Archived</label>
<span class="sub" id="refreshed">refreshed ${escapeHtml(new Date().toLocaleTimeString())}</span>
<button type="button" id="quit">Stop server</button>
</div>
<div id="status" role="status"></div>
</header>
<main id="inbox">${body}</main>
<script nonce="${escapeHtml(input.nonce)}">${SCRIPT}</script>
</body>
</html>
`;
}
