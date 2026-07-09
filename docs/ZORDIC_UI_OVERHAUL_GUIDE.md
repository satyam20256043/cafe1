# ZORDIC UI/UX OVERHAUL GUIDE — v1.1 (for a Sonnet execution session)

Execute work packages **UI0 → UI7 in order, committing after each one**. This guide is
self-contained: read §0–§2 fully before touching any file. When a step says ASK THE USER,
use AskUserQuestion and do not proceed on that item without an answer.

---

## 0. Context — read first

**Zordic California** is a multi-tenant SaaS for cafés/restaurants (AI WhatsApp receptionist,
QR table ordering, loyalty, CRM, marketing), rented monthly to independent cafés. It is **not
a franchise system**: each café is an isolated tenant that sees only its own data; the user
(platform operator) is the only person with cross-tenant visibility.

- **Live in production**: `https://zordic.in` — AWS Lightsail (Ubuntu, 414MB RAM + 2GB swap),
  Node via pm2 (app name `zordic`, dir `~/zordic`), Caddy reverse proxy with auto-HTTPS.
- **Repo**: `https://github.com/satyam20256043/cafe1`. ⚠️ GitHub's default branch `main` is an
  old unrelated scaffold. **All real code is on `master`.** Never merge or compare against `main`.
- **Local codebase**: `C:\Users\SSJ\Desktop\cafe-ai-bot`. The root `server.js` is a frozen
  legacy monolith — never edit it. **All work happens in `data\` and `public\`**:
  - `data\server.js` — main app (routes not yet extracted, helpers, `routeCtx`, Socket.io)
  - `data\db.js` — SQLite schema + helpers (better-sqlite3, WAL mode)
  - `data\auth.js` — JWT auth handlers/middleware
  - `data\routes\*.js` — 10 modular route files registered with `register(routeCtx)`
  - `public\*.html` — every page is a self-contained HTML file (inline CSS + JS, no build step)
- **Database is a clean slate**: 0 businesses in production and locally. `data\businesses.json`
  is `[]` in git and must stay `[]` in commits (it's runtime state, written by the server).
- There is an orphaned crash-artifact file `data\.fuse_hidden0000001d00000001` that contains
  old copies of server code. **Never edit it and never port code from it without verifying
  against the live schema** (it has stale patterns).

### The pages and their current design languages (the inconsistency you will fix)

| Page | Audience | Current style |
|---|---|---|
| `login.html`, `admin-login.html`, `onboard.html` | staff/public | "Luxury espresso": dark `#0D0705`, gold `#C9A84C`, Cinzel + Cormorant + Nunito Sans |
| `manager.html`, `kitchen.html` | café staff | Light cream, gold accents, own ad-hoc palette |
| `portal.html`, `hq.html`, `index.html` | owner / admin | Modern light: DM Sans + DM Serif Display, different variable names |
| `cafe.html`, `table-order.html` | customers | Themeable (8 themes exist), café-ish but Zordic-branded |

### What already works and MUST NOT regress (verified in the 2026-07-09 QA sweep)

Café login (`/login`) with role-based redirect · admin login (`/admin-login` → `/hq`) ·
all 15 manager tabs · order placement with server-computed totals + coupons · order status
updates (manager + kitchen) · QR ordering end-to-end (`/order/:id`) · reservations (web +
manager approve) · AI campaign generation (Gemini `gemini-2.5-flash`) · chat simulator ·
chat history · tenant isolation (cross-branch = 403) · self-registration (`/onboard`) ·
self-service password change (manager Settings panel + portal modal) · WhatsApp OTP
forgot-password (`/api/auth/forgot-password` + `/api/auth/reset-password`, UI in login.html) ·
HQ dashboard (all 7 tabs) · agency-admin access to any café's manager/kitchen/portal via URL.

---

## 1. Ground rules (hard constraints — violating these caused real production bugs before)

1. **`ctx.db` is NOT the raw SQLite handle.** In route modules, `db` from `routeCtx` is the
   whole `db.js` exports object. `db.prepare(...)` / `db.exec(...)` will crash with
   "db.prepare is not a function". For raw SQL use **`db.raw().prepare(...)`**. This exact
   mistake shipped broken code twice (backup.js, marketing.js chat history). Before committing,
   run: `grep -rn "\bdb\.prepare(\|\bdb\.exec(" data/routes/ data/server.js` — every hit must
   be `db.raw().…` or inside `db.js` itself.
2. **Realtime**: always `emitToBranch(branchId, event, payload[, {public:true}])` from
   routeCtx. Never a bare `io.emit(...)` (Phase-0 cross-tenant leak).
3. **Auth**: every new staff endpoint gets `requireAuth, requireBranchAccess`. Agency-wide
   endpoints get `requireAuth, requireRole('agency_admin','admin')`. Public/customer endpoints
   must return sanitized payloads only (see `publicBusinessView` in `data/routes/business.js`).
4. **Roles** are: `agency_admin`, `admin`, `owner`, `manager`, `kitchen`, `waiter`, `cashier`.
   Front-end authGuards: manager.html allows `['manager','owner','agency_admin','admin']`;
   hq.html allows `['agency_admin','admin']` and redirects to `/admin-login`. Keep it that way.
5. **Session storage keys**: staff pages use `localStorage` `cafehq_token` / `cafehq_staff` /
   `cafehq_businessId`. portal.html additionally mirrors into `sessionStorage`
   `portal_token/portal_biz/portal_staff` and has a `urlBranchId()` helper so agency admins
   viewing `/portal/:id` follow the URL, not their token. Don't break either mechanism.
6. **Secrets**: never read out or print `.env` values, passwords, or tokens into the chat or
   into committed files. Never commit `.env` (gitignored). If a credential must be created,
   generate it in a script that prints only in the user's own terminal, and ASK THE USER first.
7. **Test-data hygiene** (mandatory after every local test — see §6 Testing protocol):
   delete test businesses from SQLite + their `data/<id>/` folder + reset
   `data/businesses.json` to `[]` before committing. Run `git status` before every commit and
   never commit test pollution (`data/<testcafe>/`, modified `businesses.json`,
   `data/activity_log.json` — the latter two are runtime files).
8. **Commits**: one commit per work package (UI5 may be one commit per page), imperative
   subject, body explains the why. End with:
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
9. **Deploying**: the user runs commands in the Lightsail *browser* SSH terminal, which
   **corrupts multi-line pastes**. Give them ONE single line only:
   `cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`
   Notes: pm2's error log will show a stale historical `db.prepare is not a function` entry
   from before an old fix — ignore it; only worry about NEW timestamps. `--update-env` is
   required whenever `.env` changed.
10. **Production smoke-testing**: `https://zordic.in/hq` and `/admin-login` are behind **Caddy
    HTTP Basic Auth** — curl returns 401 without the user's personal credentials. That 401 is
    correct behavior; never ask for those credentials and never try to bypass. Test admin flows
    locally instead.
11. **Local dev server**: `node data/server.js` (PORT from `.env`, default 3010), or the
    preview config `.claude/launch.json` (name `zordic-dev`). Local `.env` already has working
    `GEMINI_API_KEY`, `JWT_SECRET`, `WHATSAPP_VERIFY_TOKEN`.
12. **Windows/PowerShell**: local curl needs `--ssl-no-revoke` for https to production.

---

## 2. UI0 — Design tokens + prep (do this first)

**Goal**: one source of truth for the visual language, so every later package pulls from the
same palette instead of adding a fourth ad-hoc style.

**Decision already made with the user**: standardize on the **espresso/gold** identity
(the login/onboard look) as the brand. Staff pages keep their *lighter* backgrounds for
long-session readability but adopt the same accent palette and component styles. Fonts:
Cinzel for display/brand moments, Nunito Sans for UI text on dark pages; staff pages may keep
DM Sans for dense data (font unification is optional — palette unification is mandatory).

**Steps**

1. Checkpoint: `git log --oneline -1` and confirm clean `git status`. Boot locally, confirm
   `[Phase1] ✓ SQLite + Auth + Backup modules loaded` and no startup errors.
2. Create **`public/zordic-ui.css`** defining CSS custom properties + a few shared components:

   ```css
   :root{
     /* Brand */
     --z-gold:#C9A84C; --z-gold-light:#E2C97E; --z-gold-dark:#A07830;
     --z-espresso:#0D0705; --z-espresso-2:#1A1008; --z-cream:#FAF3E0;
     /* Light (staff) surfaces */
     --z-bg:#FAF7F0; --z-surface:#FFFFFF; --z-border:#E8E0D0;
     --z-ink:#2A2018; --z-ink-2:#6B5D4A; --z-ink-3:#9A8870;
     /* Semantic */
     --z-success:#2d7a2d; --z-success-bg:#f0f9f0;
     --z-danger:#C0392B;  --z-danger-bg:#fdf0ee;
     --z-warn:#B8860B;    --z-info:#2C6E9E;
     /* Shape */
     --z-radius:10px; --z-radius-lg:14px;
     --z-shadow:0 2px 10px rgba(42,32,24,.07);
     --z-shadow-lg:0 8px 32px rgba(42,32,24,.16);
   }
   .z-skel{position:relative;overflow:hidden;background:var(--z-border);border-radius:6px;min-height:14px}
   .z-skel::after{content:'';position:absolute;inset:0;transform:translateX(-100%);
     background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
     animation:z-shimmer 1.2s infinite}
   @keyframes z-shimmer{to{transform:translateX(100%)}}
   .z-badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em}
   ```
3. Link it (`<link rel="stylesheet" href="/zordic-ui.css">`) from every page you touch in later
   packages — do NOT bulk-edit all pages now.
4. **Adoption rule**: any NEW style you write from UI1 onward uses `var(--z-…)` tokens.
   Existing styles are migrated only in UI5.

**Verify**: server boots; `/zordic-ui.css` returns 200; no page visually changed yet.
**Commit**: `UI0: add shared design tokens (zordic-ui.css) — espresso/gold system`

---

## 3. UI1 — Per-café login URLs (kills the all-cafés dropdown)

**Problem**: `/login` and portal's login list *every café on the platform* in a dropdown —
clunky at 5 cafés, unusable at 50, and a privacy leak (each café sees the whole customer list;
competitors see each other).

**Design**: each café gets `zordic.in/login/<branchId>`. The page shows *that café's* name,
locks the branch (no dropdown), and behaves otherwise identically. Bare `/login` keeps working
as a fallback during transition.

**Steps**

1. `data/server.js`: next to the existing `app.get('/login', …)` add
   `app.get('/login/:branchId', (req,res)=>res.sendFile(path.join(ROOT_DIR,'public','login.html')));`
2. `public/login.html`:
   - On load, derive `urlBranch`: `const p=location.pathname.split('/').filter(Boolean);`
     `const urlBranch = (p[0]==='login'&&p[1]) ? p[1] : new URLSearchParams(location.search).get('branch');`
   - If `urlBranch`: fetch `/api/businesses/${urlBranch}` (public endpoint exists in
     `data/routes/business.js`, returns sanitized view). If found: **hide the branch
     `<select>` row entirely**, render the café's name (and location) as a static header line
     inside the card, and keep the value in a hidden input feeding the existing submit code.
     If NOT found: show the normal dropdown plus a soft warning ("Café link invalid — pick
     your branch"). Do not hard-fail.
   - The existing `?branch=` pre-select logic is superseded by this — keep it as the fallback
     path, don't duplicate.
3. `public/portal.html`: same treatment for its login screen — when `urlBranchId()` (helper
   already exists) resolves to a real café, hide the `login-branch` select and show the café
   name; keep the dropdown only on bare `/portal`.
4. Update everything that hands out login links to use the per-café form:
   - `public/onboard.html` success card: add a "Login URL" row → `/login/<businessId>`.
   - `data/routes/business.js` `/api/onboard` welcome-WhatsApp message: change the manager
     link line to include `Login: ${BASE_URL}/login/${id}`.
   - `grep -rn "'/login'" public/ data/` and update any redirect that can know its branch
     (e.g. manager/kitchen/portal authGuard redirects: use
     `'/login/'+ (localStorage.getItem('cafehq_businessId')||'')` with bare `/login` fallback).
5. **UI1b (optional hardening — ASK THE USER first)**: "Now that logins are per-café, do you
   want the public café directory removed too?" If yes: (a) `GET /api/businesses` for
   non-staff callers returns `[]` or 403; first `grep -rn "api/businesses'" public/` and fix
   every consumer — known ones: `index.html` (the System Portal home page lists branches —
   replace with static marketing copy + "Register your café" button to `/onboard`),
   `login.html`/`portal.html` fallback dropdowns (they'd need a "café code" text input
   instead), the `__snav` strip. This is a breaking change — only with explicit user approval,
   and test every consumer after.

**Verify** (locally, with a test café from §6): `/login/<id>` shows café name, no dropdown,
login works and redirects by role; `/login` unchanged; invalid id falls back gracefully;
onboard success card shows the login URL; portal per-café login locked. Run the §7 regression
spot-checks for login flows.
**Commit**: `UI1: per-café login URLs — remove all-cafés dropdown from the happy path`

---

## 4. UI2 — First-run setup checklist (the conversion feature)

**Problem**: a newly registered café lands in an empty dashboard with zero guidance. This is
where trials die.

**Design**: a dismissible "Get set up" card at the top of the manager **Overview** tab and the
owner portal dashboard: ① Customize your menu → ② Print table QR codes → ③ Connect WhatsApp →
④ Place a test order. Each step: label, done/pending state, one button that jumps to exactly
the right place.

**Steps**

1. Per-branch flag file `data/<branchId>/setup.json`:
   `{ "menuDone":false, "qrDone":false, "dismissed":false }` (WhatsApp + first-order are
   computed live, not stored). Use the existing `getBranchData`/`writeBranchData` helpers from
   routeCtx if they support arbitrary filenames — check first
   (`grep -n "function getBranchData" data/server.js`); otherwise small fs read/write with
   try/catch defaults.
2. New endpoint in `data/routes/extras.js` (or a new tiny route file registered in
   server.js):
   - `GET /api/businesses/:id/setup-status` — `requireAuth, requireBranchAccess` — returns
     `{ menuDone, qrDone, whatsappConnected, hasFirstOrder, dismissed }` where
     `whatsappConnected` = `data/<id>/whatsapp_config.json` exists with a non-empty
     `phoneNumberId`, and `hasFirstOrder` = `db.raw().prepare('SELECT COUNT(*) c FROM orders WHERE business_id=?').get(id).c > 0`.
   - `POST /api/businesses/:id/setup-status` — same middleware — accepts partial
     `{menuDone,qrDone,dismissed}` and merges into setup.json.
3. Set `menuDone:true` automatically from the existing menu-save endpoint (find it:
   `grep -n "menu" data/routes/*.js data/server.js | grep -i "app.post\|app.put"`) — one line
   after a successful save.
4. Front-end card (manager Overview, before the KPI row; portal dash top): 4 rows with ✓/○
   icon, label, and a button — Menu → `showTab('menu',…)`; QR → `showTab('qrcodes',…)` plus a
   "Mark done" that POSTs `qrDone:true`; WhatsApp → `showTab('settings',…)` (the WhatsApp
   panel is in Settings); Test order → `window.open('/order/'+branchId+'?table=test')`.
   "Dismiss" link POSTs `dismissed:true`. Card hidden when `dismissed` or all four complete.
   Style with `--z-…` tokens. In portal, buttons deep-link to
   `/manager/<id>` (owner has manager access).
5. Make sure `initializeBusinessFiles(id)` (in `data/server.js`) doesn't need changes — new
   cafés simply have no setup.json until first write; the GET endpoint must default cleanly.

**Verify**: register a fresh test café via `/api/onboard` → checklist shows 0/4 →
save menu → auto ✓ → create `whatsapp_config.json` with a fake phoneNumberId → ✓ →
place an order via `/order/<id>` → ✓ → "Mark done" on QR → card auto-hides; dismiss works;
another café's staff token gets 403 on the endpoint. Clean up test café (§6).
**Commit**: `UI2: first-run setup checklist for new cafés (manager Overview + owner portal)`

---

## 5. UI3 — Mobile-first manager dashboard

**Problem**: manager.html is a desktop layout (sidebar + wide tables) but café staff live on
phones. Kitchen and customer pages are already fine; this package is manager.html (and a light
pass on portal.html if needed — check it at 375px first, it's mostly cards already).

**Design** (at `max-width: 768px`):
- Sidebar hidden → **fixed bottom nav bar** with the 5 daily-use items: Overview, Orders,
  Reservations, Menu, **More**. "More" opens a full-screen sheet listing the remaining tabs
  (CRM, Reviews, AI Campaigns, Offers, Simulator, QR Codes, Loyalty, Expenses, Data Sheets,
  Settings). All buttons call the existing `showTab(id, el)` — no logic changes, navigation
  chrome only. Active-state highlight on the bottom bar.
- Content area gets bottom padding so the bar never covers actions.
- **Tables → stacked cards**: CSS-only pattern — `thead` hidden, `tr` becomes a bordered card,
  `td{display:block}` with `td::before{content:attr(data-label)}`. This requires adding
  `data-label="…"` where rows are rendered in JS. Do the high-traffic tables first:
  Reservations, CRM, Feedback, Loyalty leaderboard. The Orders tab already renders card-like
  entries — verify, don't rebuild. **Data Sheets tables may keep horizontal scroll**
  (power-user surface) — wrap in `overflow-x:auto` with a sticky first column if cheap.
- Touch targets: any status/action button ≥ 44px tall on mobile.
- Modals (new order, feedback): ensure they fit 375px width (max-width:92vw, scrollable body).

**Steps**: implement as ONE `@media (max-width:768px){…}` block appended to manager.html's
style plus the bottom-nav markup + a small `More` sheet div; then the `data-label` additions
in the JS render functions of the four listed tables.

**Verify**: with the preview browser resized to 375×812 (or DevTools emulation), click through
ALL 15 tabs — no horizontal body scroll, nav reachable, order status buttons tappable, modals
usable, and desktop (1280px) completely unchanged. Console: zero errors on every tab.
**Commit**: `UI3: mobile layout for manager dashboard — bottom nav + card-style tables`

---

## 6. UI4 — Café-first branding + remove admin traces from café-facing pages

**Problem A — whose brand is it**: customer-facing pages (`table-order.html`, `cafe.html`)
lead with Zordic branding. The customer is *the café's* customer; the café's name/colors
should lead, with a discreet "Powered by Zordic California" in the footer only.

**Problem B — admin traces**: several staff/customer pages carry a top strip (`__snav…` ids)
with an "🏢 Admin HQ" link, and manager.html has agency links. A café owner clicking them just
hits the Basic-Auth wall (no security issue), but per the user's explicit requirement the
agency layer should be **invisible** to cafés.

**Steps**

1. `grep -rn "__snav\|Admin HQ\|/hq" public/*.html` — for every hit decide:
   - Customer-reachable pages (`cafe.html`, `table-order.html`, `order`, anything a QR code
     opens): **remove the strip/link entirely**.
   - Staff pages (`manager.html`, `kitchen.html`, `portal.html`): keep the strip but
     **role-gate the Admin HQ link** — render only when
     `JSON.parse(localStorage.getItem('cafehq_staff')||'null')?.role` is
     `agency_admin`/`admin` (manager.html already does this pattern for its agency links
     inside `initStaffUI()` — reuse it, and audit that the existing gating still covers
     everything after this pass).
2. `table-order.html`: header already shows café name — make it the visual anchor (café name
   large, use the café's `brandColor` from `/api/businesses/:id` as the accent CSS variable);
   add footer line `Powered by Zordic California ☕` small/muted. Remove any Zordic-first
   header branding.
3. `cafe.html`: same principle. Additionally add two optional per-café image settings —
   `heroImageUrl`, `galleryUrls` (comma-separated) — editable in manager Settings → Branch
   Details, stored with the business record, used by cafe.html when set (falls back to the
   current stock Unsplash defaults). **No file uploads** in this pass (no storage layer) —
   URL fields only; note real uploads as future work.
4. Check `login.html` footer: "Agency Website" link — rename to something café-neutral or
   remove from per-café login pages (keep on bare `/login` if you like).

**Verify**: open `/order/<id>` and `/cafe/<id>` as a logged-out browser — zero admin/agency
links anywhere, café name leads, brandColor applied, "Powered by" footer present. Log in as a
café owner → manager/kitchen/portal show no Admin HQ link. Log in as agency admin → link
visible again. Settings image URLs round-trip and render.
**Commit**: `UI4: café-first branding on customer pages + hide agency layer from café staff`

---

## 7. UI5 — One design language (gradual, one page per commit)

**Goal**: every page reads as one product. Mandatory: palette + component consistency.
Optional: font unification (skip if it churns too much).

**Order of migration** (each its own commit, verify after each):
1. **hq.html** (admin-only, lowest risk): link `zordic-ui.css`; remap its local CSS variables
   to the `--z-…` palette (keep its layout/structure — it's good); status badges/buttons use
   the semantic tokens.
2. **portal.html**: same remap; its card/quick-access layout stays.
3. **manager.html + kitchen.html**: accents, buttons, badges, panels onto tokens; backgrounds
   stay light. Do NOT restructure — color/typography swap only.
4. **index.html** (System Portal home): restyle into the espresso/gold family; if UI1b was
   approved this page became marketing copy — style that.
5. Leave `login/admin-login/onboard` as-is (they ARE the reference look) except pointing any
   hex values at the shared tokens where trivial.

**Method per page**: screenshot before → link tokens file → replace the page's `:root` values
with references to `--z-…` (keep local aliases so inline `var(--gold)` keeps working:
`--gold:var(--z-gold);` — minimal diff, maximal consistency) → screenshot after → eyeball
diff → full console-error check on every tab/section of that page.

**Commits**: `UI5a: hq.html onto shared tokens` … `UI5d: index.html onto shared tokens`

---

## 8. UI6 — Polish pass (loading, errors, confirms, trial, push)

Each item is small; do them in this order and commit once at the end (or split if any grows).

1. **Skeleton loaders**: `grep -rn "Loading…\|Loading\.\.\." public/` — replace bare text with
   2–4 `.z-skel` divs sized like the content (tables: 3 skeleton rows). Target: hq tables,
   manager tab loads, portal dash.
2. **Friendly errors**: `grep -rn "HTTP '+\|HTTP \${" public/` and any raw `e.message` surfaced
   to users — replace with plain sentences ("Couldn't load orders — check your connection and
   try again."), keep the technical detail in `console.error`. Add a tiny per-page helper
   `function friendly(msg){…}` where repeated.
3. **Confirmations**: audit destructive actions —
   `grep -rn "Cancel\|delete\|remove\|✕" public/manager.html public/kitchen.html` — order
   cancel (manager + kitchen), menu item remove, staff deactivate, campaign reject. Minimum
   bar: `if(!confirm('Cancel this order? The customer will be notified.'))return;` with
   consistent copy. Skip anything already confirmed.
4. **Trial visibility (owner side)**: portal.html `showSubscriptionBanner` exists — for
   `trial` status show "🎁 X days left in your free trial" + an **Upgrade** button calling the
   existing `openBillingModal(bizId)`. ⚠️ `data/plans.json` DOES NOT EXIST, so
   `/api/plans` returns `{plans:[]}` and the modal is empty. **ASK THE USER** for real plan
   names/prices/durations, then create `data/plans.json`:
   `{"plans":[{"id":"starter","name":"Starter","price":1999,"duration_days":30,"features":["…"],"badge":""}, …]}`
   (schema consumed by `data/routes/billing.js` `loadPlans()`, hq.html `openGenLink`, and
   portal's billing modal — verify all three render). If Razorpay keys aren't configured the
   payment step 503s with a clear message — make the modal show "Contact us to upgrade"
   fallback in that case instead of a dead button.
5. **Push notifications** (audit first, timebox it): `grep -rn "web-push\|VAPID\|pushManager\|serviceWorker\|sendPush" data/ public/`
   to map what exists (there's a `sendPushToPhone` in routeCtx and a boot warning about VAPID
   keys). If the subscribe→store→send path is complete except keys: generate keys locally with
   `npx web-push generate-vapid-keys`, put them in local `.env`, verify a new-order push fires
   to a subscribed manager browser, then give the user single-line instructions to generate
   keys **on the server themselves** and add to server `.env` (never move keys through chat),
   followed by the standard deploy line. If the path is half-built and would take real
   construction, document findings in the commit message and defer — don't half-ship push.

**Verify**: each item individually; then console-error sweep on every page.
**Commit**: `UI6: polish — skeletons, friendly errors, confirms, trial upgrade card[, push]`

---

## 9. UI7 — Full regression, cleanup, deploy

1. **Test-data purge** (§6 protocol) — then `git status` must show only intended files.
2. **Full regression run locally** (fresh test café for the flows that need one):
   - `/login/<id>` per-café login + bare `/login` fallback + wrong-password rejection
   - `/admin-login` → `/hq` (local admin) — all 7 HQ tabs load, no console errors
   - Owner login → portal (no double login) → manager via quick-access → all 15 tabs
   - Place order via `/order/<id>` (mobile viewport!) → appears in kitchen → status updates
     propagate → today's stats update in portal
   - Reservation via `/cafe/<id>` → approve in manager
   - AI campaign generate (Gemini) + chat simulator round-trip + chat history shows it
   - Coupon: 5-star feedback issues code → order redeems it → reuse rejected
   - Password change (manager + portal) and forgot-password OTP endpoints (rate-limit fires)
   - Tenant isolation: café A token on café B's CRM = 403
   - Setup checklist lifecycle (UI2) and NO admin links visible to café roles (UI4)
3. Push to `origin master`, then give the user the single-line deploy command.
4. **Post-deploy smoke** (from your machine, `--ssl-no-revoke`):
   `https://zordic.in/` 200 · `/login` 200 · `/onboard` 200 · `/hq` **401** (Basic Auth — expected) ·
   `/api/businesses` 200 `[]` · spot-check one UI1 page renders the new markup
   (`curl … | grep <new-element-id>`).
5. Update `docs/` notes and the session memory files if the session has them.

---

## §6 Testing protocol (use for every package)

**Create a disposable café** (backend does everything):
```
curl -s -X POST http://localhost:3010/api/onboard -H "Content-Type: application/json" \
  -d '{"businessName":"UI Test Cafe","ownerName":"UI Tester","ownerPhone":"9990001111"}'
```
→ note `businessId`, `staff.username`, `staff.tempPassword` from the response. The account
role is `manager`. For admin-flow tests create a temp agency admin via a local script
(INSERT into `staff` with `business_id='_agency'`, role `agency_admin`, bcrypt hash) and
delete it afterwards — never reuse or print the user's real admin credentials.

**Destroy it afterwards — full block (adjust the id):**
```
node -e "const D=require('better-sqlite3');const db=new D('data/cafe_hq.db');
const id='<TESTCAFE_ID>';
['orders','customers','menu_items','reservations','feedback','offers','settings','audit_log',
 'events','coupons','loyalty_points','loyalty_transactions','chat_messages','staff']
 .forEach(t=>db.prepare('DELETE FROM '+t+' WHERE business_id=?').run(id));
db.prepare('DELETE FROM businesses WHERE id=?').run(id);
db.prepare('DELETE FROM password_reset_otps WHERE staff_id NOT IN (SELECT id FROM staff)').run();
db.close();console.log('cleaned');"
```
then `rm -rf data/<TESTCAFE_ID>` and reset `data/businesses.json` to `[]`.

---

## §7 Out of scope for this overhaul (do not start these)

- Real image uploads / file storage (URL fields only in UI4)
- Hindi/Hinglish UI localization
- Admin-account (agency) password recovery
- Phase-1 analytics features (customers_v2, Daily Growth Brief, Weekly Impact Report)
- Payment/pricing changes beyond creating `plans.json` with user-approved values
- Server resize / infra changes
- The ~28 orphaned legacy test-tenant folders in `data\` (user has deferred cleanup twice)

---

## Appendix — file map & known consumer lists

- Login surfaces: `public/login.html` (staff), `public/admin-login.html` (agency — do not
  add café features here), portal.html embedded login.
- `GET /api/businesses` consumers (relevant to UI1b): `index.html`, `login.html`,
  `portal.html`, `__snav` strip snippets, hq.html (authed).
- Manager tab ids: overview, reservations, menu, crm, feedback, campaigns, offers, simulator,
  orders, qrcodes, loyalty, expenses, datasheet, settings, clients (agency-only).
- WhatsApp per-café config: `data/<branchId>/whatsapp_config.json`
  (`phoneNumberId`, `accessToken`); helpers `getWaConfig`, `sendWhatsAppToCustomer` in
  `data/server.js`.
- Setup-relevant helpers in routeCtx: `getBranchData`, `writeBranchData`, `emitToBranch`,
  `normalizePhone`, `logEvent`, `db` (module — remember `db.raw()` for SQL).
