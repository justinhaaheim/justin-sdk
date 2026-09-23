/**
 * THE BROWSER RENDERING (home-base-p1uj D14) — the answer page's report panel.
 *
 * `thread answer --ui web` shows Justin the report the asks came from, so he can
 * see what he is answering against. Until now that panel was
 * `<pre>${escapeHtml(notes)}</pre>`: the whole report as one block of monospace,
 * with nothing marking the P0 he was meant to look at.
 *
 * This renders the same document with structure — headings, the glance line, and
 * one block per ask carrying its priority as a class, so the page's stylesheet
 * can make a P0 unmistakable and a P4 quiet. Like the ansi renderer it styles
 * `renderMarkdown`'s output through the shared classifier (see
 * `report-lines.ts`), which is what lets the page do this with only the thread
 * bead's stored text in hand.
 *
 * EVERY VALUE IS ESCAPED. The report contains Justin's own last message
 * verbatim, Claude's prose, and bead titles — all of it arbitrary text that must
 * never become markup.
 */

import type {ReportLine} from './report-lines';
import type {ReportModel} from './report-model';

import {normalizeReportText, renderMarkdown} from './render-markdown';
import {
  classifyReport,
  isRenderedReport,
  parseOptionLine,
} from './report-lines';

/** The one escaper. Order matters: `&` first, or the others are double-escaped. */
export function escapeReportHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** `p0`…`p4`, or `pUnknown` for a marker this build does not recognise. */
function priorityClass(priority: number | null): string {
  return priority == null ? 'pUnknown' : `p${priority}`;
}

function htmlLine(line: ReportLine): string {
  const escaped = escapeReportHtml(line.text);
  switch (line.kind) {
    case 'blank':
      return '';
    case 'glance':
      return `<p class="glance">${escapeReportHtml(line.rest)}</p>`;
    case 'where':
      return `<p class="where">${escaped}</p>`;
    case 'heading':
      return `<h3>${escapeReportHtml(line.label ?? '')}</h3>`;
    case 'field':
      return `<p class="field"><strong>${escapeReportHtml(line.label ?? '')}:</strong> ${escapeReportHtml(line.rest)}</p>`;
    case 'ask':
      return `<p class="ask ${priorityClass(line.priority)}"><strong>${escapeReportHtml(line.label ?? '')}.</strong> ${escapeReportHtml(line.rest)}</p>`;
    case 'askDetail': {
      // An option arrives as a nested-list item (`- a. …`, K11 rule 6); the
      // page shows it as the lettered paragraph it always was — the markdown's
      // list marker is for the chat UI, not for this page's structure.
      const option = parseOptionLine(line.rest);
      const shown =
        option == null
          ? line.rest
          : `${option.letter}. ${option.recommended ? '(Recommended) ' : ''}${option.text}`;
      return `<p class="askdetail ${priorityClass(line.priority)}">${escapeReportHtml(shown)}</p>`;
    }
    case 'rule':
      // The emoji rules are a scrollback delimiter for a terminal; in a page
      // they are a horizontal line and nothing else.
      return '<hr />';
    case 'bullet':
      return `<li>${escapeReportHtml(line.rest)}</li>`;
    case 'mistake':
      // Its own class, not a list item: a mistake is one of the two things the
      // compact report exists to show (D23), and the page's stylesheet has to be
      // able to make it as loud as a P0.
      return `<p class="mistake">${escaped}</p>`;
    case 'pointer':
      return `<p class="pointer">${escaped}</p>`;
    case 'note':
      return `<p class="note"><strong>${escapeReportHtml(line.label ?? '')}</strong>${escapeReportHtml(line.rest)}</p>`;
    case 'command':
      return `<p class="command">${escaped}</p>`;
    case 'continuation':
      return `<p class="continuation">${escapeReportHtml(line.rest)}</p>`;
    case 'numbered':
    case 'text':
      return `<p>${escaped}</p>`;
  }
}

/**
 * Style an already-rendered report. Used by `renderHtml` and by the answer page,
 * which has the thread bead's stored notes and no model.
 *
 * Consecutive bullets are wrapped in one `<ul>`, so a list reads as a list
 * rather than as loose `<li>`s the browser has to guess at. The blank line the
 * markdown now puts between list items (K11 rule 1) does not end the list —
 * only a line that is not a bullet does — so the page's structure is the same
 * as before the spacing change; its breathing room comes from the stylesheet.
 */
export function htmlFromReportText(markdown: string): string {
  const out: string[] = ['<div class="report">'];
  let inList = false;
  const text = isRenderedReport(markdown)
    ? normalizeReportText(markdown)
    : markdown;
  for (const line of classifyReport(text)) {
    if (line.kind === 'blank') continue;
    const html = htmlLine(line);
    if (line.kind === 'bullet') {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(html);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (html !== '') out.push(html);
  }
  if (inList) out.push('</ul>');
  out.push('</div>');
  return out.join('\n');
}

/** The whole report, as an HTML fragment. */
export function renderHtml(model: ReportModel): string {
  return htmlFromReportText(renderMarkdown(model));
}
