# Zordic — v1.0 Launch Guide (for a Claude Sonnet 5 session)

> **Purpose:** take Zordic from "boots on a laptop" to **live in production with WhatsApp**, on a
> data-collection-first strategy. Ship the working operations core + AI receptionist + a Business
> Intelligence event log + coupon tracking + WhatsApp (inbound auto-reply) + deployment.
> **Defer** all predictive AI (Daily Brief, Weekly Report, churn/forecasting) — those come later,
> fed by the data we start collecting now.
>
> **Strategy (why this order):** the moat is DATA, not AI. Launch value that cafés use daily
> (ordering, reservations, loyalty, feedback, WhatsApp receptionist) so real data accumulates from
> day one. The event log (LP1) is the spine that makes every future AI feature possible without a
> DB redesign later.
>
> Companion docs: `docs\ZORDIC_MASTER_PLAN.md` (strategy), `docs\ZORDIC_PHASE1_PLAN.md` (the full
> Phase-1 build — its WP1/WP2 are partly pulled forward here as LP1/LP2; the predictive WPs are deferred).
> Execute LP0 → LP7 in order. Commit after each LP. Use **Sonnet 5**; slow down on LP3 (WhatsApp
> webhook) and LP5 (deploy).

## Ground rules (Phase 0 guarantees — do NOT break)
- Work ONLY in `data\` (`data\server.js`, `data\db.js`, `data\routes\*.js`, `public\*`). Never edit
  the root `server.js` monolith.
- Realtime: always `emitToBranch(branchId, event, payload[, {public}])`. Never a bare `io.emit`.
- Every new STAFF endpoint: `requireAuth, requireBranchAccess`. Agency endpoints:
  `requireRole('agency_admin','admin')`. Customer-facing reads stay sanitized.
- AI discipline: Gemini phrases; deterministic JS computes/decides. Always a non-Gemini fallback.
- Normalize phones to last-10-digits (add/consolidate a shared `normalizePhone()` in `db.js`).

## Current state (already done — do NOT redo)
- Phase 0 committed (`e74279b`): security + tenant isolation complete.
- `package.json` already fixed: `npm start` → `data/server.js`; unused `whatsapp-web.js` dependency
  removed. **These edits are uncommitted — commit them in LP0.**
- `.env` already has a real Gemini key + a strong rotated `JWT_SECRET`.
- WhatsApp **Cloud API** code exists (`data\whatsapp-api.js` + webhook + per-branch setup) but is
  UNPROVEN end-to-end — LP3 audits and finishes it. Do NOT reintroduce `whatsapp-web.js` (ban risk).

---

## LP0 — Pre-flight & safety
1. `git add -A && git commit` the pending `package.json` fix ("chore: correct npm start entrypoint,
   drop unused whatsapp-web.js").
2. Back up the DB: copy `data\cafe_hq.db` → `data\cafe_hq.db.pre-launch.bak`.
3. Complete `.env.example` (committed, no secrets) to document ALL vars the app reads:
   `PORT, GEMINI_API_KEY, JWT_SECRET, JWT_EXPIRES, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
   VAPID_PUBLIC, VAPID_PRIVATE, VAPID_EMAIL, BASE_URL, WHATSAPP_VERIFY_TOKEN` (the last is new, added in LP3).
   Include a JWT secret generator note: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
4. Add a shared `normalizePhone(p)` helper to `db.js`; export it and add to `routeCtx`.
5. Boot check: `node data\server.js` on a spare port → clean startup; `/api/businesses` returns tenants.
**Verify:** clean commit; clean boot; DB backup exists.

## LP1 — Business Intelligence Event Log (the data spine — the centerpiece)
**Goal:** an append-only log so every meaningful action is captured with timestamp + metadata.
Even unused now, it powers all future AI without a schema redesign.
- Table in `db.js`:
```
events(
  id INTEGER PK AUTOINCREMENT,
  business_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,        -- dotted: customer.new, customer.repeat, order.placed,
                                    -- order.status, payment.paid, reservation.created,
                                    -- reservation.status, feedback.submitted, review.claimed,
                                    -- review.verified, coupon.issued, coupon.redeemed,
                                    -- loyalty.earned, loyalty.redeemed, campaign.sent,
                                    -- chat.inbound, chat.outbound, walkin.registered
  customer_phone TEXT,              -- normalized last-10, nullable
  actor TEXT,                       -- 'customer' | 'staff:<id>' | 'system' | 'ai'
  metadata TEXT,                    -- JSON (items, amount, rating, code, campaign id, channel, etc.)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)
CREATE INDEX idx_events_biz_time  ON events(business_id, created_at DESC);
CREATE INDEX idx_events_biz_type  ON events(business_id, event_type);
CREATE INDEX idx_events_biz_phone ON events(business_id, customer_phone);
```
- Helper `logEvent(businessId, eventType, { customerPhone, actor, metadata })` in `db.js`; export +
  add to `routeCtx`. Must be crash-safe (wrap in try/catch — logging must never break a request).
- **Wire `logEvent` into every meaningful action** (reuse existing code paths; add one call each):
  - `routes/orders.js`: order placed, status change, payment verified.
  - `server.js` chat (`processCafeBotReply` / `/chat` / webhook): chat.inbound + chat.outbound;
    reservation.created + feedback.submitted at the points those already write JSON.
  - `routes/marketing.js`: web reservation, web feedback, offer approve, AI-campaign approve,
    gbp review sync, google-review approve/reject.
  - `routes/loyalty.js`: award/redeem, birthday-campaign send.
  - `server.js`: walk-in registered, at-risk send-offer, `runAutoPilotCampaign` (campaign.sent),
    `updateCustomerProfile` (customer.new on first insert, customer.repeat on later).
- Read endpoints (staff): `GET /businesses/:id/events?type&from&to&limit` and an agency roll-up
  `GET /api/admin/events` (agency_admin). These are the raw data surface for later analytics.
**Verify:** place an order, chat, submit feedback → corresponding rows appear in `events` with correct
`business_id`, `event_type`, `customer_phone`, and a useful `metadata` JSON.

## LP2 — Coupon tracking (captures campaign → redemption → revenue data)
**Goal:** replace today's bare string codes (`THANKYOU15`, `REVIEW15`) with tracked coupons so
"campaign sent → redeemed → visit after campaign" becomes real data (not guesses).
- Table `coupons` in `db.js` (id, business_id, code UNIQUE, source_type, source_id, customer_phone,
  discount_type, discount_value, status[issued|redeemed|expired], issued_at, expires_at, redeemed_at,
  order_id, redeemed_revenue). Index (business_id, status).
- Helpers: `issueCoupon({...})` (readable unique code e.g. `WIN-4F2A`; also `logEvent(...,'coupon.issued')`),
  `validateCoupon(bizId, code)`, `redeemCoupon(bizId, code, orderId, orderTotal)` (also
  `logEvent(...,'coupon.redeemed')`).
- Issue coupons at every offer/campaign path (AI-campaign approve, offer approve, 5-star feedback,
  google-review verified, at-risk win-back, autopilot, birthday) — replace the hardcoded strings.
- Redeem at order time: `orders.js POST /orders` accepts optional `couponCode` → validate → apply
  discount to server-computed totals → mark redeemed. Add staff endpoint
  `POST /businesses/:id/coupons/validate` for the billing UI.
- Add a simple coupon field in the manager Orders/new-order flow (`public\manager.html`).
**Verify:** approve a campaign → `coupons` row `issued` + event; place an order with that code →
`redeemed` with order_id + revenue + event. (No dashboards required for launch — raw data is enough.)
**NOTE:** the unified `customers_v2` record (Phase-1 WP1) is DEFERRED as a fast-follow — the event log
already captures per-customer history for now, so don't block launch on that migration.

## LP3 — WhatsApp Cloud API, Level 1 (inbound AI receptionist) — the "include WhatsApp" work
**Goal:** a customer messages the café's WhatsApp → the AI receptionist replies, takes reservations,
answers menu/loyalty. (Level 2 proactive marketing templates are DEFERRED — needs approved
templates + opt-in; do NOT mass-broadcast at launch = ban risk.)
- **Audit first:** READ the existing webhook in `data\server.js`
  (`GET /api/webhook/whatsapp`, `POST /api/webhook/whatsapp`), plus `getWaConfig`,
  `sendWhatsAppToCustomer`, `data\whatsapp-api.js`, and `POST /businesses/:id/whatsapp/setup`.
  Confirm/repair this exact flow:
  1. **GET verify:** respond to Meta's `hub.challenge` when `hub.verify_token` matches a single global
     `process.env.WHATSAPP_VERIFY_TOKEN` (simplest for multi-tenant — one callback URL for the app).
  2. **POST receive:** parse the payload; get the receiving number's `phone_number_id`; **map it to a
     branch** by matching each branch's stored `whatsapp_config.json.phoneNumberId`; extract sender
     phone + text; call `processCafeBotReply(branchId, phone, text)`; send the reply via
     `waApi.sendMessage(phoneNumberId, accessToken, sender, reply)`; `logEvent` chat.inbound/outbound;
     `emitToBranch(branchId,'inbound_chat',...)` so the manager chat log shows it. Return 200 fast.
  3. Idempotency: ignore statuses/echoes/group messages; de-dupe on message id.
- Per-branch setup UI already exists (manager Settings → WhatsApp: phoneNumberId, accessToken). Confirm
  it saves and that `whatsapp/status` reflects "configured".
- Add `WHATSAPP_VERIFY_TOKEN` to `.env`/`.env.example` and to the code's env reads.
**Verify (needs LP5 deployed first for a public URL):** register a **Meta test number**, point its
webhook to `https://<domain>/api/webhook/whatsapp` with the verify token, send a WhatsApp message to
the test number → the AI replies; `events` shows chat.inbound/outbound; manager chat log updates for
that branch only.

## LP4 — Production security & config
- **Change the seeded owner passwords** (`owner`/`cafe1234`) for all real branches (use
  `PUT /api/admin/staff/:id/password` as agency_admin, or the manager change-password flow). Non-negotiable.
- **Rotate the Gemini API key** (it was previously exposed) — new key at aistudio.google.com, update `.env`.
- Confirm `JWT_SECRET` is the strong rotated value (boot fails otherwise — that's the Phase 0 guard).
- Razorpay: launch decision — leave keys blank to run **cash-only** (code already guards `if(!razorpay)`),
  OR set live keys if taking online payments day one. Blank is fine for v1.
- CORS: currently `origin:'*'`. Acceptable for launch (API is JWT-protected); tighten to the domain in a
  fast-follow.
- Optional: set `VAPID_*` to enable web push; skip if not needed at launch.
**Verify:** default password no longer works; server boots with the new keys; a protected endpoint 401s
without a token and 200s with one.

## LP5 — Deploy to a public HTTPS server (AWS Lightsail / any Ubuntu VPS)
**Why now:** WhatsApp webhooks require a public HTTPS URL — the app must be deployed before LP3 verifies.
Single Node process + SQLite → one small box. Lightsail (or a $5–10 Ubuntu droplet) is enough for launch.
**Server prep (Ubuntu 22.04+):**
```
sudo apt update && sudo apt install -y curl git build-essential python3   # build-essential+python3 = better-sqlite3 native build
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Node 20 LTS
sudo apt install -y nodejs
sudo npm i -g pm2
```
**App:**
```
git clone <your repo>  zordic   # or scp the folder up (WITHOUT node_modules / .env)
cd zordic
npm ci                          # installs deps; better-sqlite3 compiles here
# create .env on the server (do NOT commit it): copy your local .env values + set:
#   PORT=3010   BASE_URL=https://<domain>   WHATSAPP_VERIFY_TOKEN=<random string>
pm2 start npm --name zordic -- start
pm2 save && pm2 startup     # run the printed command so it restarts on reboot
```
**HTTPS + domain (Caddy = automatic Let's Encrypt):**
```
sudo apt install -y caddy
# /etc/caddy/Caddyfile:
#   <your-domain> {
#       reverse_proxy localhost:3010
#   }
sudo systemctl restart caddy
```
- Point the domain's A record at the server IP. Open ports 80 + 443 (Lightsail networking / `ufw`).
- Move the pre-launch DB backup + set up an offsite copy of `data\cafe_hq.db` (the daily 2 AM backup
  already runs; also copy the file off the box periodically).
**Verify:** `https://<domain>` serves the portal; `https://<domain>/cafe/indiranagar` loads; API works
over HTTPS; `pm2 logs zordic` clean.

## LP6 — End-to-end verification on the LIVE server
Run the real flows once, as a customer + as staff:
1. Café page loads; menu/prices correct.
2. QR order (`/order/:id`) → appears on kitchen screen (`/kitchen/:id`) → mark served → loyalty stamp
   awarded → `events` logged.
3. Reservation via chat + via web form → shows in manager Reservations → status update works.
4. Feedback (5-star) → coupon issued + Google-review nudge → `events` logged.
5. Chatbot answers menu/timing/"sasta kya hai"/book-a-table in English + Hinglish.
6. **WhatsApp:** test-number message → AI replies (LP3 verify).
7. HQ: onboard a fresh test café; activate/suspend; confirm it appears.
8. Tenant isolation: open two branches in two tabs — a socket event in one must NOT reach the other.
9. Public API sanitized (no owner PII/WiFi without a token); protected endpoints 401 without token.
10. `events` table is filling up across all of the above.
**Then delete the test café** created in step 7 (or leave it — cleanup is deferred).

## LP7 — Go-live & ongoing updates
- Onboard your first real café via HQ; hand the owner their manager login (with a changed password).
- Start the café's **Meta WhatsApp business verification NOW** (it can take days) if using their real
  number; use the test number to demo in the meantime.
- **Update workflow** (for "keep updating the live site"): on the server →
  `git pull && npm ci && pm2 restart zordic` (add `npm ci` only when dependencies changed).
  Always take a DB copy before a risky deploy. Commit + push small, frequent changes.
- Watch `pm2 logs zordic` and the `events` table for the first days.

---

## Deferred (fast-follow, NOT launch-blocking) — build later, fed by the event log
- Unified `customers_v2` record + migration (Phase-1 WP1) — trustworthy CRM for AI.
- Daily Growth Brief, Weekly Impact Report (Phase-1 WP4/WP5).
- Predictive AI: churn, revenue/demand forecasting, personalized offers, profit optimization —
  need ~2–6 weeks of the data LP1 is now collecting.
- WhatsApp Level 2 (proactive marketing): approved message templates + opt-in/consent tracking +
  frequency caps (the compliance layer) BEFORE any mass broadcast — otherwise numbers get banned.
- Staff-performance & table-occupancy analytics (need schema additions), inventory.
- Tighten CORS to the domain; add `/healthz`; move to Litestream→S3 DB replication.

## Positioning for launch (set expectations honestly)
"Manage your customers, orders, reservations, loyalty, and WhatsApp from one place. As your business
data grows, Zordic's AI learns YOUR café and gives increasingly personal recommendations." — the AI
improves over weeks because it learns from their real history, not generic assumptions.
