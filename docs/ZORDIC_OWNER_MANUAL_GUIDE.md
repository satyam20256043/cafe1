# ZORDIC OWNER MANUAL GUIDE — v1.0 (for a Sonnet execution session)

**Status: M0–M4 all complete** (2026-07-11) — `public/Zordic-Owner-Guide.pdf` shipped, 32 pages,
3.2MB, 21 annotated screenshots across 20 screens + 5 written-only chapters (Getting Started,
Daily Routine, How the AI Works, Connecting WhatsApp, FAQ). Verified via Chromium's native PDF
viewer (correct pagination, no mid-page image cuts, back cover isolated). One real bug caught
and fixed during build: the legend CSS's leftover `display:grid` rule was squeezing badge titles
into a 26px column — removed, badges render correctly. Live at `zordic.in/Zordic-Owner-Guide.pdf`
once deployed. To regenerate for a future UI change: re-run M0–M4 below (the seed script, shoot
rig, and guide builder are not committed — recreate them in a scratchpad from this doc).

Build **`public/Zordic-Owner-Guide.pdf`** — a complete, branded manual for café owners and
managers with an annotated screenshot of every screen and an explanation of **every button
and feature**. Execute packages **M0 → M4 in order, committing after each**. Everything in
§2 was already proven working in the session that wrote this guide (2026-07-11) — the seed
script ran successfully end-to-end and Puppeteer launched and screenshotted. Do not
re-derive; reuse.

---

## 0. Context

- **Codebase**: `C:\Users\SSJ\Desktop\cafe-ai-bot`. All work in `data\` + `public\` + `docs\`.
  Repo `github.com/satyam20256043/cafe1`, branch **`master`** only.
- **Audience for the PDF**: non-technical Indian café owners/managers. Simple English,
  benefit-first (product charter: outcomes like "more repeat customers", never jargon).
- The manual covers the product as of commits `01d408b`/`1d627d3`: manager dashboard
  (15 tabs incl. Customer Chats, AI Discount Limit, per-item AI Max %), kitchen display,
  owner portal, customer order page, escalations "Needs You" card, growth suggestions,
  10-day trial, plans incl. "Premium AI receptionist powered by Claude" on Growth/Pro.
- **Style**: numbered gold callout badges (not hand-drawn arrows) + a matching numbered
  legend under each screenshot — cleaner, fully scriptable, professional-manual standard.
  Brand: espresso `#2A2018`, gold `#C9A84C`, cream `#FAF7F0` (tokens in `public/zordic-ui.css`);
  logos: `public/logo.svg` (light bg), `public/logo-dark.svg` (dark bg).

## 1. Ground rules

- Server for screenshots runs via **Bash background** (`node data/server.js`, port 3010) —
  NOT the preview tool (its sandbox blocks outbound network, so Gemini falls back and chat
  seed content looks canned; Bash-run gives real AI replies. GEMINI_MODEL is already set to
  `gemini-3.1-flash-lite` in local `.env`).
- **Puppeteer is NOT a project dependency** — do not add it to package.json. Install it in
  the session scratchpad: `npm init -y && npm i puppeteer` (downloads Chromium, ~1 min;
  verified working on this machine). All build scripts live in the scratchpad; only the
  final PDF goes into `public/`.
- Login for Puppeteer pages: **inject the token, don't drive the login form** (form submit
  is flaky under automation). Proven pattern:
  `POST /api/auth/login {businessId, username, password}` → then in the browser context
  `localStorage.setItem('cafehq_token', token); localStorage.setItem('cafehq_staff', JSON.stringify(staff))`
  on any same-origin page, then `page.goto('/manager/<id>')`.
- Tab navigation inside manager.html: `document.querySelector('.nav-item[onclick*="<tab>"]').click()`
  then wait ~800–1200ms for data loads. Tab names: overview, reservations, menu, crm, chats,
  feedback, campaigns, offers, simulator, orders, qrcodes, loyalty, expenses, datasheet, settings.
- Test-café hygiene: the demo café is created fresh by the seed script and **must be purged
  before the final commit** (stop server FIRST, then delete SQLite rows across all
  business_id tables, `rm -rf data/<id>`, reset `data/businesses.json` to `[]`). Known trap:
  editing businesses.json while the server runs gets silently overwritten.
- Screenshot viewport: **1280×800 desktop**. Use `fullPage: true` for tall tabs.
- Known artifacts to ignore in `git status`: `data/data/backups/*`, `public/~$Zordic-Pitch.pptx`.

## 2. Proven assets — reuse verbatim

### 2a. Demo-café seed script (RAN SUCCESSFULLY 2026-07-11 — copy into scratchpad as seed_demo.js)

Creates "Brew Haven Cafe" with: chat history (Aman), an offer request (Kavita), café-wide
AI discount 10% + Cold Coffee override 25% + a granted DEAL coupon (Rohan), a complaint
escalation (Meera), a 5★ feedback + THX coupon (Arjun), a chat reservation (Sneha 4 guests)
+ a web reservation (Vikram), 3 orders (one served → loyalty points, one preparing, one
pending), extra loyalty awards, 2 expenses. It prints `CAFE_ID=`, `USER=`, `PASS=`.

```js
'use strict';
const BASE = 'http://localhost:3010';
async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function put(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: 'PUT', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function chat(id, phone, text, customerName) {
  return post(`/api/businesses/${id}/chat`, { phone, text, customerName });
}
(async () => {
  const ob = await post('/api/onboard', {
    businessName: 'Brew Haven Cafe', ownerName: 'Priya Sharma',
    ownerPhone: '9876543210', location: 'Indiranagar, Bengaluru', timings: '9:00 AM - 10:00 PM',
  });
  if (!ob.body || !ob.body.success) throw new Error('onboard failed: ' + JSON.stringify(ob.body));
  const id = ob.body.businessId;
  const { username, tempPassword } = ob.body.staff;
  console.log('CAFE_ID=' + id); console.log('USER=' + username, 'PASS=' + tempPassword);
  const login = await post('/api/auth/login', { businessId: id, username, password: tempPassword });
  const token = login.body.token; if (!token) throw new Error('login failed');
  await chat(id, '9876501111', 'hi', 'Aman Verma');
  await chat(id, '9876501111', 'what are your timings?', 'Aman Verma');
  await chat(id, '9876502222', 'any special discount for me?', 'Kavita Rao');
  await put(`/api/businesses/${id}/settings`, { aiMaxDiscount: 10 }, token);
  const menuR = await fetch(BASE + `/api/businesses/${id}/menu`); const menu = await menuR.json();
  const cc = menu.find(m => m.name === 'Cold Coffee'); if (cc) cc.aiMaxDiscount = 25;
  await post(`/api/businesses/${id}/menu`, menu, token);
  await chat(id, '9876503333', 'discount on cold coffee please', 'Rohan Iyer');
  await chat(id, '9876504444', 'the food was disgusting, I want a refund', 'Meera Nair');
  await chat(id, '9876505555', 'I want to give feedback', 'Arjun Malhotra');
  await chat(id, '9876505555', '5', 'Arjun Malhotra');
  await chat(id, '9876505555', 'Amazing coffee and lovely vibe! Will come again.', 'Arjun Malhotra');
  await chat(id, '9876506666', 'book a table', 'Sneha Kulkarni');
  await chat(id, '9876506666', 'Sneha', 'Sneha Kulkarni');
  await chat(id, '9876506666', '4', 'Sneha Kulkarni');
  await chat(id, '9876506666', 'tomorrow 8 PM', 'Sneha Kulkarni');
  await post(`/api/businesses/${id}/reservations`, { name: 'Vikram Joshi', phone: '9876507777', guests: 2, datetime: 'Sunday 1:00 PM' });
  const o1 = await post(`/api/businesses/${id}/orders`, { customerName: 'Aman Verma', customerPhone: '9876501111', tableNo: '5', orderType: 'dine-in', items: [{ id: '1', qty: 2 }, { id: '2', qty: 1 }], paymentMethod: 'upi' });
  const o2 = await post(`/api/businesses/${id}/orders`, { customerName: 'Kavita Rao', customerPhone: '9876502222', tableNo: '2', orderType: 'dine-in', items: [{ id: '4', qty: 1 }, { id: '5', qty: 2 }], paymentMethod: 'cash' });
  await post(`/api/businesses/${id}/orders`, { customerName: 'Rohan Iyer', customerPhone: '9876503333', tableNo: '7', orderType: 'dine-in', items: [{ id: '6', qty: 1 }], paymentMethod: 'upi' });
  const oid = o => o.body && (o.body.order ? o.body.order.id : o.body.id);
  if (oid(o1)) await post(`/api/businesses/${id}/orders/${oid(o1)}/status`, { status: 'served' }, token);
  if (oid(o2)) await post(`/api/businesses/${id}/orders/${oid(o2)}/status`, { status: 'preparing' }, token);
  await post(`/api/businesses/${id}/loyalty/award`, { phone: '9876505555', name: 'Arjun Malhotra', amountSpent: 540, orderId: 'seed1' }, token);
  await post(`/api/businesses/${id}/loyalty/award`, { phone: '9876506666', name: 'Sneha Kulkarni', amountSpent: 320, orderId: 'seed2' }, token);
  await post(`/api/businesses/${id}/loyalty/award`, { phone: '9876505555', name: 'Arjun Malhotra', amountSpent: 410, orderId: 'seed3' }, token);
  await post(`/api/businesses/${id}/accounting/expenses`, { category: 'ingredients', amount: 4200, description: 'Coffee beans + dairy', vendor: 'FreshFarm Traders', expenseDate: new Date().toISOString().slice(0, 10) }, token);
  await post(`/api/businesses/${id}/accounting/expenses`, { category: 'utilities', amount: 1850, description: 'Electricity bill', vendor: 'BESCOM', expenseDate: new Date().toISOString().slice(0, 10) }, token);
  console.log('TOKEN=' + token); console.log('SEED DONE');
})().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
```

### 2b. Annotation technique (inject before screenshot via page.evaluate)

For each screen define `[{ selector, n }]`. In the page: for every entry,
`el.style.outline = '3px solid #C9A84C'; el.style.outlineOffset = '2px';` then append
`<div>` positioned at the element's top-left `getBoundingClientRect()` corner (offset −13px)
with: 26px circle, `background:#C9A84C`, white bold number, `border:2px solid #fff`,
`box-shadow:0 1px 6px rgba(0,0,0,.35)`, `z-index:2147483647`, `position:absolute` +
`window.scrollY` added to `top`. Screenshot AFTER injecting. Badges + legend replace arrows.

## 3. Work packages

### M0 — Setup + capture rig
Scratchpad: install puppeteer; start server (Bash bg); run seed_demo.js; note CAFE_ID/creds.
Write `shoot.js`: launches Chromium 1280×800, injects login localStorage, and exposes
helpers `gotoTab(name)`, `annotate(list)`, `snap(filename, {fullPage})` saving PNGs to
`scratchpad/shots/`. Verify with one Overview screenshot (badges visible, escalation card
present). **Commit nothing yet** (scratchpad only).

### M1 — Capture all screens (~20 PNGs)
For every screen: navigate, wait for data, annotate the key controls, snap. Chapters/screens:

1. **Login** `/login/<id>` — fields, sign-in button, forgot-password link.
2. **Overview tab** — KPI cards, setup checklist, ⚠️ "Needs You" escalation card (Meera's
   refund complaint: annotate Mark Handled + WhatsApp Customer buttons), growth card slot,
   sidebar nav itself (badge the sections: Operations/Customers/Marketing/Tools).
3. **Reservations** — pending rows (Sneha 4 guests, Vikram 2), approve/cancel actions.
4. **Menu & Pricing** — + Add Item, Save Menu, item name/description/image fields, category
   dropdown (+ Custom…), Price, Disc %, **AI Max %** column, Available/86'd toggle, delete ✕,
   and the **AI Discount Limit** panel below (input + Save Limit + explanation).
5. **CRM** — Register Walk-in, at-risk panel, insights search, broadcast campaign form,
   customer table (tiers/tags).
6. **Customer Chats** — conversation list (Aman/Kavita/Rohan/Meera/Arjun/Sneha), search box,
   open thread view (in/out bubbles), live-update note.
7. **Reviews** (feedback tab) — Arjun's 5★ entry, AI reply draft button, Google sync.
8. **AI Campaigns** — suggestion generator, approve/send controls, autopilot toggle.
9. **Offer Requests** — Kavita's pending request, Approve (custom text) / Reject.
10. **Chat Simulator** — phone/name/message inputs, quick chips, conversation window
    (explain: test your AI safely here; customers never see it).
11. **Orders & Revenue** — order cards incl. statuses (pending/preparing/served), status
    advance buttons, revenue KPIs, coupon field if present.
12. **Table QR Codes** — grid, print button, explain scan→order flow.
13. **Kitchen Display** `/kitchen/<id>` (own page; same token works) — ticket columns,
    status buttons, the pending order from Table 7.
14. **Loyalty & Rewards** — lookup/award/redeem controls, leaderboard (Arjun on top),
    birthdays, activity feed.
15. **Expenses** — add-expense form (category/amount/vendor/date/GST), list, totals.
16. **Data Sheets** — dataset pills, export CSV button ("your data is yours").
17. **Settings** — café details, change password, **WhatsApp connect** (Phone Number ID /
    Access Token / Test button — pair with a simplified 3-step summary and a pointer that
    Zordic support helps with this step), Razorpay keys, billing/plan info if shown.
18. **Owner Portal** `/portal/<id>` — login as same user; revenue overview, menu editor,
    chat history panel (this is the away-from-café view).
19. **Customer order page** `/order/<id>?table=5` — what guests see: menu, cart, place
    order, live status tracker (shoot at mobile 390×844 for realism).
20. **Landing/plans** `zordic.in` (local `/`) — pricing cards incl. "Premium AI receptionist
    powered by Claude" on Growth (context for upgrades).

Sanity-check each PNG exists and is >30KB before moving on (a truncated/blank shot means the
wait was too short — retry that screen; `waitForSelector` on a tab-specific element).

### M2 — Write the manual content (guide.html in scratchpad)
A4 print CSS (`@page { size: A4; margin: 14mm }`), brand fonts/colors, cover page
(logo.svg, title "Zordic — Owner & Manager Guide", zordic.in, version/date), table of
contents, then one chapter per screen: intro paragraph (what this screen is FOR, in
owner-benefit language) → `<img>` (max-width 100%, border, subtle shadow) → numbered legend
(`<ol>`) where **every badge number gets 1–3 sentences**: what the control does + when/why
to use it. Also non-screenshot chapters:
- "Getting started" (your login link `zordic.in/login/<cafe-id>`, credentials from
  onboarding, change password on day one)
- "Your daily 5-minute routine" (morning: Overview → escalations first, then reservations,
  then Chats; evening: Orders & Revenue glance)
- "How the AI receptionist works for you" (auto-answers, when it escalates to you — the four
  triggers — and the discount ceilings YOU control)
- "Connecting WhatsApp" (simplified; heavy lifting referenced to Zordic support — do NOT
  reproduce docs/CAFE_WHATSAPP_ONBOARDING.md's admin-level detail)
- FAQ/Troubleshooting (forgot password → WhatsApp OTP; AI not replying → check WhatsApp
  connection in Settings + contact support; wrong menu price → Menu tab, Save)
- Back cover: support contact + zordic.in.
Embed images as `file://` absolute paths (works for local print) or base64.
Tone: charter rules — outcomes first, plain English, no tech jargon, ₹ examples.

### M3 — Render the PDF + verify
`page.goto('file://…/guide.html')` → `page.pdf({ path: 'public/Zordic-Owner-Guide.pdf',
format: 'A4', printBackground: true })`. Verify: file exists (expect roughly 1.5–6MB,
25–45 pages), then reopen the PDF is not possible visually — so ALSO screenshot guide.html
at 3–4 scroll positions (cover, a mid chapter, legend detail) via puppeteer and eyeball via
Read tool on the PNGs to confirm layout/badges/images render. Fix and re-render as needed.
The PDF is auto-served at `https://zordic.in/Zordic-Owner-Guide.pdf` after deploy.

### M4 — Cleanup, commit, deploy note
1. Stop server; purge demo café (SQLite rows all business_id tables + folder +
   businesses.json → `[]`). Purge any stray `ai_eval_cafe_*` if present.
2. `git status` clean except known artifacts; commit **only** `public/Zordic-Owner-Guide.pdf`
   (+ this guide's status line update):
   `docs: owner & manager guide PDF with annotated screenshots`
3. Push; give the user the single-line deploy
   (`cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`);
   after deploy the link to share with café owners is `zordic.in/Zordic-Owner-Guide.pdf`.
4. Update session memory (project file): manual shipped, where it lives, how to regenerate
   (this guide).

## 4. Out of scope
- Hindi/Hinglish translation of the manual (future edition; note it on the back cover)
- Video tutorials; printed-copy layout tweaks (bleed/CMYK)
- Admin/HQ documentation (owners must never see agency features — do NOT screenshot /hq)
- Any product code changes — if a screen looks broken during capture, report it, don't fix
  it inside this task (file it for a separate session) unless it blocks a screenshot
  entirely.
