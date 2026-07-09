# ZORDIC LANDING + AI ESCALATION GUIDE — v1.0 (for a Sonnet execution session)

Execute work packages **G0 → G5 in order, committing after each one**. This guide is
self-contained: read §0–§3 fully before touching any file. Every product decision in §1 was
made explicitly by the user on 2026-07-09 — do **not** re-ask them. The only permitted
ASK THE USER moment is flagged inside G1.

---

## 0. Context — read first

**Zordic California** is a multi-tenant SaaS for cafés/restaurants (AI WhatsApp receptionist,
QR table ordering, loyalty, CRM, marketing), rented monthly to independent cafés. It is **not
a franchise**: each café is an isolated tenant that sees only its own data; the user
(platform operator) is the only person with cross-tenant visibility.

- **Live in production**: `https://zordic.in` — AWS Lightsail (Ubuntu, 414MB RAM + 2GB swap),
  Node via pm2 (app name `zordic`, dir `~/zordic`), Caddy reverse proxy with auto-HTTPS.
  `/hq*` and `/admin-login*` are additionally behind Caddy HTTP Basic Auth — they returning
  **401 in smoke tests is correct**, not a bug.
- **Repo**: `https://github.com/satyam20256043/cafe1`. ⚠️ GitHub's default branch `main` is an
  old unrelated scaffold. **All real code is on `master`.** Never merge or compare against `main`.
- **Local codebase**: `C:\Users\SSJ\Desktop\cafe-ai-bot`. The root `server.js` is a frozen
  legacy monolith — **all work happens in `data\`** (`data\server.js`, `data\db.js`,
  `data\routes\*.js`) and `public\*`.
- The UI0–UI7 overhaul (see `docs\ZORDIC_UI_OVERHAUL_GUIDE.md`) is complete and deployed.
  Shared design tokens live in `public/zordic-ui.css` (`--z-*` espresso/gold palette).
  `data/plans.json` exists (Starter ₹1500 / Growth ₹3000 / Pro ₹5000) and is served by
  `GET /api/plans`. Push notifications (VAPID) are configured and live in production.
- **Product charter** (`docs\ZORDIC_MASTER_PLAN.md`): every feature and every line of copy is
  framed as a **business outcome for the café owner** — more customers, more repeat visits,
  more revenue. Never feature-first ("we have CRM"), always outcome-first ("bring lapsed
  customers back").

## 1. Locked user decisions (2026-07-09 — do not re-ask, do not re-litigate)

1. **Landing page `/`** becomes a real **marketing page** for prospective café owners:
   revenue-growth pitch, features, the 3 plans, "Start your 10-day free trial" CTA → `/onboard`,
   plus a small "Staff sign in" link. **Every admin trace is removed** (the current page shows
   "+ Add New Café", "HQ View", an "Onboard New Client" quick-start card, an "Agency Admin —
   That's You" role card, and a full URL table including `/hq` — all of that goes).
   The user reaches `/hq` by typing the URL directly; it stays double-gated (Caddy Basic Auth
   + agency_admin app login) and linked from nowhere public.
2. **`/onboard` stays public** as self-serve signup, but the free trial is **10 days**
   (currently 30 in code and copy).
3. **AI escalation notifications**: when the AI escalates, notify the café owner via
   **WhatsApp (from the café's own connected number) AND a dashboard pending item** — and the
   notification must include the **AI's suggestion with the reason**, framed around growing
   revenue (user's example: "run a Tuesday offer to make Tuesday busy too").
4. **Escalation triggers** (all four): complaints/refunds · large group bookings ·
   questions the AI can't answer · payment/billing disputes. (Custom discount requests
   already escalate today via the Offer Requests approval flow — leave that as is.)
5. From the same discussion, also accepted: **manager.html's "Back to HQ" sidebar link**
   (currently `<a href="/" class="back-btn">Back to HQ</a>`) must be hidden from café roles —
   gate it to `agency_admin`/`admin` exactly like the existing `link-agency-hq` pattern.
6. The user additionally wants **proactive growth suggestions** sent to owners (not only
   reactive escalations): e.g. detect the café's slowest weekday and suggest a campaign to
   fill it, with the reasoning and expected benefit. That is package G4.

## 2. Ground rules (violating these has caused real production bugs before)

- **`ctx.db` in route modules is the whole `db.js` exports object, NOT the raw better-sqlite3
  instance.** Raw SQL in a route must use `db.raw().prepare(...)`. Bare `db.prepare(...)`
  crashes at request time. Prefer adding prepared helpers inside `data/db.js` itself.
- **Realtime**: always `emitToBranch(branchId, event, payload[, {public}])` from `data/server.js`.
  Never a bare `io.emit(...)` (was a cross-tenant leak once already).
- **Auth**: staff endpoints get `requireAuth, requireBranchAccess`. Agency-wide endpoints get
  `requireRole('agency_admin','admin')`. Customer-facing reads stay sanitized.
- **Gemini discipline (INTENT protocol)**: Gemini only *classifies and phrases*. All decisions
  (what counts as an escalation, thresholds, what action fires) are deterministic JS. Gemini
  never writes to the DB. Every Gemini-dependent feature ships a working non-Gemini fallback
  (system must run with no `GEMINI_API_KEY`).
- **WhatsApp sends**: per-café Cloud API creds live in `data/<branchId>/whatsapp_config.json`
  (`phoneNumberId`, `accessToken`); `getWaConfig(businessId)` in `data/server.js` reads them;
  `waApi.sendMessage(phoneNumberId, accessToken, to, text)` sends. A café with no WhatsApp
  connected must **degrade gracefully** (dashboard-only, no crash, no error toast). For the
  `to` number format, copy exactly what the existing forgot-password OTP send in
  `data/server.js` does with `staff.phone` — do not invent your own formatting.
- **Secrets**: never print, commit, or move real credentials through chat. `.env` is gitignored.
- **Test-data hygiene**: every package that needs data uses a disposable café (§6) and deletes
  it fully before committing. `git status` before each commit must show only intended files.
- **One commit per package**, detailed commit messages documenting what was verified.
- **Deploy commands for the user must be single-line `&&`-chained** (their Lightsail browser
  SSH terminal corrupts multi-line pastes).
- pm2's error log persists across restarts — old stack traces (e.g. a stale
  `db.prepare is not a function` from marketing.js:901, long fixed) appearing after a deploy
  are historical, not new. Judge deploys by the out log + smoke tests.

## 3. Working-tree state you inherit (IMPORTANT)

Four small edits from §1-decision #2 are **already made locally and uncommitted**. `git status`
at start must show exactly `data/routes/business.js` and `public/onboard.html` modified.
Do NOT revert them — verify them and fold them into **G2's commit**:

1. `data/routes/business.js` — quick-add path: `trialEnds` now `10*24*60*60*1000` (was 30).
2. `data/routes/business.js` — `/api/onboard` path: `trialEnds` now `10 * 24 * 60 * 60 * 1000` (was 30).
3. `public/onboard.html` — hero pill now "10-Day Free Trial".
4. `public/onboard.html` — trial badge now "**10 days free.** No credit card. Cancel anytime."

If the tree shows anything else modified at start, stop and reconcile before proceeding.

---

## G0 — Pre-flight

1. `git branch --show-current` must be `master`; `git status` must match §3 exactly.
2. Copy `data/cafe_hq.db` → `data/cafe_hq.db.pre-g.bak` (local safety net; gitignored).
3. Boot locally (`node data/server.js`, port 3010 via `.env`) — clean boot, then create and
   immediately clean up one disposable café (§6) to confirm the loop works.
4. No commit for G0.

## G1 — Public landing page → marketing site (+ last admin-trace removals)

**Problem**: `public/index.html` is an internal control panel served publicly (see §1-#1).

**Rebuild `index.html` from scratch** (full rewrite, keep only: favicon links, the
DM Serif Display/DM Sans font links, the `zordic-ui.css` link, and the existing `:root`
token-alias block from UI5d). Structure:

1. **Header**: Zordic logo/wordmark · right side: "Staff Sign In" (ghost button → `/login`)
   + "Start Free Trial" (primary → `/onboard`).
2. **Hero**: outcome-first headline (e.g. "More customers. More repeat visits. More revenue."),
   subline explaining the AI answers every WhatsApp message, takes orders & bookings 24/7,
   and brings lapsed customers back automatically. CTAs: "Start your 10-day free trial" →
   `/onboard` and "See pricing" → `#pricing`. Trust line: "No credit card · Set up in 2 minutes".
3. **How it works** — 3 steps: Register your café (2 minutes) → Connect your WhatsApp →
   The AI starts handling customers 24/7.
4. **Features grid** (6 cards, outcome-framed): AI WhatsApp receptionist · QR table ordering ·
   Loyalty & rewards · AI win-back campaigns · Live revenue dashboard · Google review growth.
5. **Pricing** (`id="pricing"`): fetch `GET /api/plans` client-side and render the 3 plan cards
   (name, ₹price/month, badge, features, "Start 10-day free trial" CTA → `/onboard`). If the
   fetch fails, show a graceful "Contact us to get started" card — never a broken section.
6. **Closing CTA band** + **footer**: © Zordic California · small "Staff sign in" link.

**Must NOT appear anywhere in the rendered page**: "HQ", "Admin", "Agency", "Onboard New
Café/Client", any URL table, any role cards. Grep the served HTML/innerText for those strings
as part of verification.

**ASK THE USER (only if needed)**: if you want a public contact channel (WhatsApp number /
email) on the page, ask for it — otherwise ship with `/onboard` as the only CTA and no
contact details.

**Same commit — manager.html back-link gating**: find
`<a href="/" class="back-btn">…Back to HQ</a>` in the sidebar footer of `public/manager.html`
(near `link-agency-hq`). Give it an id, `display:none` by default, reveal it inside
`initStaffUI()` only for `agency_admin`/`admin` — identical pattern to `link-agency-hq` a few
lines above it.

**Verify**: landing renders all sections at desktop + 375px mobile width; plans load from the
API; forbidden strings absent; zero console errors; `/login`, `/onboard` still fine. Manager
as café `manager` role: no Back-to-HQ link; with an injected `agency_admin` in
localStorage: link visible.
**Commit**: `G1: public landing page → marketing site; gate last agency link in manager`

## G2 — Finish the 10-day trial change

§3's four edits are already in the tree. Finish the stragglers:

1. `public/onboard.html` (~line 271): success-screen fallback text
   `'30 days from today'` → `'10 days from today'`.
2. `public/hq.html` `renderCards()`: trial progress bar math `((30-dl)/30)` → `((10-dl)/10)`.
3. `grep -rn "30" public/onboard.html public/index.html data/routes/business.js` — fix any
   remaining *trial-related* 30s (ignore unrelated numbers like "Last 30 Days" filters in hq).

**Verify**: onboard a disposable café → API response `trialEndsAt` is 10 days out; onboard
page copy says 10 everywhere; hq branch card trial bar renders sensibly for a fresh trial
(≈0% used). Clean up the café.
**Commit**: `G2: free trial is 10 days (code + copy + HQ trial bar)`

## G3 — AI escalation engine (the big one)

**Goal**: customer messages that need a human get a calm holding reply, a dashboard pending
item, and a WhatsApp alert to the owner containing the AI's suggestion **with reasoning**.

**First, map the terrain (read before writing):**
- `grep -n "processCafeBotReply" data/server.js data/routes/*.js` — find the AI reply pipeline
  and where the INTENT protocol output is parsed (BOOKING/ORDER/OFFER/FEEDBACK intents exist).
- Find the WhatsApp inbound webhook (`/api/webhook/whatsapp`) and the chat-simulator endpoint —
  both must flow through the same escalation logic (the simulator is your local test vector,
  since you can't receive real WhatsApp locally).
- Read how the forgot-password OTP formats the owner's number for `waApi.sendMessage`.

**Storage** — new SQLite table in `data/db.js` (`CREATE TABLE IF NOT EXISTS`), with prepared
helpers exported from db.js (avoids the `db.raw()` gotcha in routes):

```
escalations(
  id TEXT PK, business_id TEXT, customer_phone TEXT, customer_name TEXT,
  category TEXT,        -- complaint_refund | large_booking | payment_dispute | unanswerable
  customer_message TEXT,
  ai_suggestion TEXT,   -- suggestion + reason shown to the owner
  status TEXT DEFAULT 'pending',   -- pending | resolved
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME, resolved_by TEXT)
```
Helpers: `createEscalation(...)`, `listEscalations(bizId, status?)`, `resolveEscalation(bizId, id, staffId)`.

**Detection (deterministic-first, Gemini-assisted):**
- Extend the AI system prompt's INTENT protocol with an `ESCALATE|<category>|<one-line summary>`
  intent for: complaints/anger/refund demands · payment/billing disputes · questions outside
  its café knowledge (low confidence — instruct it to escalate rather than guess).
- **Deterministic net regardless of Gemini**: keyword check on the raw message (refund, complaint,
  manager, "paise wapas", cheated, wrong charge, double payment, etc. — include obvious
  Hindi/Hinglish variants) and, on any BOOKING intent, a guest-count check: **guests ≥ 8 ⇒
  large_booking escalation** (constant `LARGE_BOOKING_GUESTS = 8`, comment that it can become
  a per-café setting later). The deterministic net must work with Gemini disabled.

**On escalation (all deterministic):**
1. Reply to the customer with a category-appropriate holding message (complaint: sincere
   apology + "the owner has been informed and will contact you shortly"; large booking:
   "let me confirm with the team — we'll message you right back"; payment: "the team will
   verify this and get back to you quickly"; unanswerable: "let me check with the café team").
2. `createEscalation(...)` with an `ai_suggestion` built from a per-category template
   (Gemini may rephrase; template is the fallback). Each suggestion carries a **reason framed
   as revenue/retention**, e.g.:
   - complaint_refund → "Offer an apology + a make-good (free dessert coupon on next visit).
     Why: winning back an unhappy regular is far cheaper than finding a new customer."
   - large_booking → "Confirm you can seat N at <time>; consider a fixed menu for the group.
     Why: large groups raise the average ticket — worth prioritising."
   - payment_dispute → "Check the order and payment record before replying. Why: fast, factual
     responses on money issues protect your reviews."
   - unanswerable → include the exact question + "add this to your café details in Settings so
     the AI can answer it next time."
3. `emitToBranch(bizId, 'escalation_new', {…})` (staff room, not public).
4. WhatsApp the owner via the café's **own** creds (`getWaConfig(bizId)`, send to
   `biz.ownerPhone`): short alert = category, customer name/phone, message excerpt,
   the suggestion+reason, and `BASE_URL/manager/<bizId>` link. No creds ⇒ silently skip
   (dashboard still gets the item).

**API** (staff, `requireAuth, requireBranchAccess`):
`GET /api/businesses/:id/escalations?status=pending` · `POST /api/businesses/:id/escalations/:eid/resolve`.

**Dashboard (manager.html)**: a red-accented "⚠️ Needs You" panel at the **top of the Overview
tab** (above the setup checklist), listing pending escalations: category chip, customer
name/phone, their message, "AI suggests: …" line, and two buttons — **✓ Mark handled**
(resolve endpoint) and **💬 WhatsApp customer** (`https://wa.me/91<last-10>` link,
`target="_blank"`). Hide the panel entirely when there are none. Socket listener on
`escalation_new` → toast + refresh + reuse the existing browser-notification helper the page
already has for new orders. Follow the existing at-risk-panel styling in the CRM tab.

**Verify (all via chat simulator + curl, locally):** simulate "this food was cold, I want a
refund" → escalation row created, category `complaint_refund`, holding reply returned, panel
shows it, toast fires, resolve works, resolved items disappear; booking for 10 guests →
`large_booking`; nonsense question → `unanswerable`; with `GEMINI_API_KEY` removed from env,
the keyword/guest-count net still escalates. WhatsApp send path: no creds configured locally ⇒
verify it logs a graceful skip and nothing crashes. Tenant isolation: café B token gets 403 on
café A's escalations. Full manager tab sweep, zero console errors. Clean up test café.
**Commit**: `G3: AI escalation engine — holding replies, owner WhatsApp+dashboard alerts with reasoned suggestions`

## G4 — Proactive growth suggestions ("make Tuesday busy too")

**Goal**: once a week, each café's owner gets one concrete, deterministic, revenue-framed
suggestion — on WhatsApp (if connected) and on the dashboard.

- **Computation (pure JS, no Gemini for numbers)** in `data/db.js` or a small module:
  from the last 28 days of paid orders, average revenue per weekday. If the slowest weekday
  is < ~70% of the overall daily average ⇒ suggestion: "Run a <weekday> offer" with the actual
  numbers as the reason ("Tuesdays average ₹X vs ₹Y overall — filling your quietest day is the
  cheapest revenue you can add"). Fallback suggestions when there's not enough order data, in
  priority order: at-risk customers exist (`getAtRiskCustomers`) ⇒ win-back suggestion;
  upcoming birthdays ⇒ birthday-campaign suggestion; else skip this café this week.
- **Storage**: `data/<id>/growth_suggestions.json` (latest suggestion + status:
  `suggested | accepted | dismissed`, computed date).
- **Delivery**: weekly scheduler in `data/server.js`'s `server.listen` callback — copy the
  ms-until-target-then-24h-interval pattern from `data/backup.js`, firing Mondays ~10:00
  server time (note in a comment that the server runs UTC; exact hour is not critical).
  For each café: compute, store, `emitToBranch`, WhatsApp the owner if creds exist.
- **Dashboard**: "📈 Growth Suggestion" card on manager Overview (below the escalations panel):
  suggestion + reason + **[Run this campaign]** + [Dismiss]. Accepting a slow-day suggestion
  upserts a campaign for that weekday into the café's existing auto-pilot day-campaign settings
  (`lowTrafficCampaigns` — see the Settings tab's campaign rows and `runAutoPilotCampaign`)
  with a sensible default message, then toasts confirmation. Win-back/birthday acceptance
  reuses the existing at-risk send-offer / birthday-campaign endpoints.
- **Do NOT build WhatsApp reply-to-approve** ("reply YES"): the owner texting the café's own
  number would hit the customer AI pipeline. Dashboard-approve only in v1; note the relay idea
  as future work in the commit message.

**Verify**: seed a disposable café with orders skewed away from one weekday (insert via the
orders API with created_at spread — or directly via db helpers), run the compute function
directly in a node one-liner, confirm the right weekday and numbers; trigger the scheduler
function manually (export it for testability), confirm JSON written + socket event; accept ⇒
autopilot campaign row appears in Settings; dismiss ⇒ card hides. No-data café ⇒ no crash,
no suggestion. Clean up.
**Commit**: `G4: weekly growth suggestions — slow-day/win-back/birthday, dashboard approve`

## G5 — Regression, deploy, post-deploy smoke

1. Test-data purge (§6) — `git status` clean of everything except intended files.
2. Local regression: landing page (desktop+mobile, plans render, no forbidden strings) ·
   `/onboard` full signup → 10-day trial → login → manager all tabs, zero console errors ·
   escalation E2E via simulator (create → toast → resolve) · growth card renders/accepts ·
   order via `/order/<id>` still works end-to-end · `/login/<id>` + wrong-password rejection ·
   tenant isolation spot-check · admin: `link-agency-hq` and Back-to-HQ visible for
   agency_admin only.
3. Push to `origin master`; give the user the single-line deploy:
   `cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`
4. Post-deploy smoke from local machine (`curl --ssl-no-revoke`): `/` 200 and contains the new
   hero copy but NOT "HQ"/"Agency" strings · `/onboard` 200 with "10-Day" copy · `/api/plans`
   200 · `/hq` **401** (Basic Auth — correct) · `/api/businesses` 200 `[]`.
5. Update `docs\` status note + session memory files.

---

## §6 Testing protocol (use for every package)

**Create a disposable café** (backend does everything):
```
curl -s -X POST http://localhost:3010/api/onboard -H "Content-Type: application/json" \
  -d '{"businessName":"G Test Cafe","ownerName":"G Tester","ownerPhone":"9990001111"}'
```
→ note `businessId`, `staff.username`, `staff.tempPassword` (role `manager`). For admin-flow
tests, INSERT a temp `agency_admin` into `staff` (business_id `'_agency'`, bcryptjs hash) and
delete it afterwards — never use or print the user's real admin credentials.

**Destroy afterwards — full block (adjust the id):**
```
node -e "const D=require('better-sqlite3');const db=new D('data/cafe_hq.db');
const id='<TESTCAFE_ID>';
['orders','customers','menu_items','reservations','feedback','offers','settings','audit_log',
 'events','coupons','loyalty_points','loyalty_transactions','chat_messages','customer_visits',
 'expenses','escalations','staff']
 .forEach(t=>{try{db.prepare('DELETE FROM '+t+' WHERE business_id=?').run(id)}catch(e){}});
db.prepare('DELETE FROM businesses WHERE id=?').run(id);
db.prepare('DELETE FROM password_reset_otps WHERE staff_id NOT IN (SELECT id FROM staff)').run();
db.close();console.log('cleaned');"
```
then `rm -rf data/<TESTCAFE_ID>` and reset `data/businesses.json` to `[]` (with trailing newline).

## §7 Out of scope — do not start these

- Two-way owner↔AI relay over WhatsApp (owner replying to escalations by text)
- WhatsApp "reply YES to approve" for growth suggestions (see G4 note)
- Per-café escalation-threshold settings UI (constant in v1)
- Real Razorpay keys / payment flow changes
- Hindi/Hinglish UI localization; real image uploads; infra changes
- Phase-1 analytics (customers_v2, Daily Growth Brief, Weekly Impact Report) — G4 is a
  deliberately tiny slice of that vision, not the full build
- The ~28 orphaned legacy test-tenant folders in `data\` (user has deferred cleanup repeatedly)
