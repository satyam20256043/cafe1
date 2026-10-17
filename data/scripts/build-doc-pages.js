'use strict';
// Builds web pages from the Markdown in docs/:
//   docs/ZORDIC_SALES_CALL_SCRIPT.md → public/sales-call-guide.html   (sales team)
//   docs/ZORDIC_PITCH_PLAYBOOK.md    → public/sales-playbook.html     (sales team)
//   docs/ZORDICAL_OWNER_GUIDE.md     → public/owner-guide.html        (café owners, served at /owner-guide)
// Run after editing any of them:  node data/scripts/build-doc-pages.js
// Handles the Markdown these docs use: headings, paragraphs, quotes, lists, tables, rules,
// [links](url), **bold**, *italic* and `code`.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const SALES_NAV = '<span style="font-size:14px"><a href="/pitch">Pitch deck</a> · <a href="/sales-call-guide.html">Call guide</a> · <a href="/sales-playbook.html">Playbook</a></span>';
const SALES_FOOT = 'For the Zordical sales team · <a href="/sales">Back to the sales dashboard</a>';

const PAGES = [
  { src: 'docs/ZORDIC_SALES_CALL_SCRIPT.md', out: 'public/sales-call-guide.html', title: 'Sales Call Guide', noindex: true, nav: SALES_NAV, foot: SALES_FOOT },
  { src: 'docs/ZORDIC_PITCH_PLAYBOOK.md', out: 'public/sales-playbook.html', title: 'Pitch Playbook', noindex: true, nav: SALES_NAV, foot: SALES_FOOT },
  {
    src: 'docs/ZORDICAL_OWNER_GUIDE.md', out: 'public/owner-guide.html', title: 'Owner Guide',
    description: 'How to set up and run your café on Zordical: WhatsApp AI receptionist, QR table ordering, loyalty, offers and your plan.',
    nav: '<button type="button" class="print-btn" onclick="window.print()">Print or save as PDF</button>',
    foot: 'Questions? WhatsApp <a href="https://wa.me/918004284193" target="_blank" rel="noopener">+91 80042 84193</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refund">Refunds</a>',
  },
];
const DOC_LINKS = {
  'docs/ZORDIC_SALES_CALL_SCRIPT.md': '/sales-call-guide.html',
  'docs/ZORDIC_PITCH_PLAYBOOK.md': '/sales-playbook.html',
};

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (m, code) => {
    const link = DOC_LINKS[code];
    return link ? `<a href="${link}">${link === '/sales-playbook.html' ? 'Pitch Playbook' : 'Sales Call Guide'}</a>` : `<code>${code}</code>`;
  });
  // Only site-relative, in-page and http(s) links; external ones open in a new tab.
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^)\s"]*)\)/g, (m, label, url) =>
    /^https?:/.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : `<a href="${url}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s;
}

const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = l => /^(#{1,3} |> ?|\d+\. |- |\||---\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      const level = m[1].length, text = inline(m[2]);
      const id = /cheat card/i.test(m[2]) ? 'cheat-card' : slug(text);
      out.push(`<h${level} id="${id}">${text}</h${level}>`); i++; continue;
    }
    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^> ?/.test(line)) {
      const paras = [[]];
      while (i < lines.length && /^> ?/.test(lines[i])) {
        const t = lines[i].replace(/^> ?/, '');
        if (!t.trim()) paras.push([]); else paras[paras.length - 1].push(t.trim());
        i++;
      }
      out.push('<blockquote>' + paras.filter(p => p.length).map(p => `<p>${inline(p.join(' '))}</p>`).join('') + '</blockquote>');
      continue;
    }
    if (/^(\d+\. |- )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (i < lines.length && (/^(\d+\. |- )/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^(\d+\. |- )/.test(lines[i])) items.push([lines[i].replace(/^(\d+\. |- )/, '')]);
        else items[items.length - 1].push(lines[i].trim());
        i++;
      }
      const li = items.map(parts => {
        const quote = /^> ?/.test(parts[0]);
        const text = parts.map(p => p.replace(/^> ?/, '')).join(' ');
        return `<li>${quote ? `<span class="say">${inline(text)}</span>` : inline(text)}</li>`;
      }).join('');
      out.push(ordered ? `<ol>${li}</ol>` : `<ul>${li}</ul>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]), body = rows.slice(2).map(cells);
      out.push('<div class="tbl"><table><thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function page(p, bodyHtml) {
  const meta = [
    p.noindex ? '<meta name="robots" content="noindex, nofollow"/>' : '',
    p.description ? `<meta name="description" content="${escapeHtml(p.description).replace(/"/g, '&quot;')}"/>` : '',
  ].filter(Boolean).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
${meta}
<title>${p.title} — Zordical</title>
<link rel="icon" type="image/svg+xml" href="/logo-mark.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/zordic-ui.css"/>
<link rel="stylesheet" href="/legal.css"/>
<style>
blockquote{margin:12px 0;padding:12px 16px;background:var(--z-surface,#fff);border-left:3px solid var(--z-gold,#C9A84C);border-radius:0 10px 10px 0}
blockquote p{margin:0 0 8px;font-style:italic;color:var(--z-ink,#1a1612)}
blockquote p:last-child{margin-bottom:0}
.say{font-style:italic;color:var(--z-ink,#1a1612)}
code{background:var(--z-cream,#f5efe6);padding:1px 6px;border-radius:6px;font-size:14px}
hr{border:none;border-top:1px solid var(--z-border,#e8dfd2);margin:28px 0}
ol{padding-left:22px;margin:0 0 12px}
.tbl{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;width:100%;min-width:480px;font-size:15px}
th,td{border:1px solid var(--z-border,#e8dfd2);padding:9px 11px;text-align:left;vertical-align:top}
th{background:var(--z-cream,#f5efe6)}
h2,h3,#cheat-card{scroll-margin-top:16px}
.print-btn{font:inherit;font-size:14px;padding:8px 14px;border:1px solid var(--z-border,#e8dfd2);border-radius:999px;background:var(--z-surface,#fff);color:var(--z-ink-2,#4a3f35);cursor:pointer}
.print-btn:hover{border-color:var(--z-gold,#C9A84C)}
@media print{
  body{background:#fff}
  .lg-top,.lg-foot{display:none}
  main{max-width:none;padding:0}
  a{color:inherit;text-decoration:none}
  h2,h3{break-after:avoid}
  li,blockquote{break-inside:avoid}
}
</style>
</head>
<body>
<header class="lg-top">
  <a href="/"><img src="/logo.svg" alt="Zordical"></a>
  ${p.nav}
</header>
<main>
${bodyHtml}
</main>
<footer class="lg-foot">${p.foot}</footer>
</body>
</html>
`;
}

for (const p of PAGES) {
  const md = fs.readFileSync(path.join(ROOT, p.src), 'utf8');
  fs.writeFileSync(path.join(ROOT, p.out), page(p, render(md)));
  console.log(`built ${p.out} from ${p.src}`);
}
