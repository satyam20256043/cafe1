# Zordic — Phase 1 Implementation Plan

> **Status: APPROVED 2026-07-07, ready to execute.** Intended for a **Claude Sonnet 5** session
> (cost-efficient for well-specified implementation). Execute work packages in order WP0 → WP7,
> committing after each. Slow down and add rigor on WP1 (the customer-data migration).
> Companion docs: `docs\ZORDIC_MASTER_PLAN.md` (strategy) and the auto-loaded memory files.

## Context
Phase 0 (security + tenant isolation) is complete in the `data\` codebase. Phase 1 turns Zordic
from "nice dashboard" into a provable ROI machine. Four pillars:
1. **Unified customer record** (merge 4 overlapping stores → 1 trustworthy source of truth).
2. **Attribution loop** (every offer/campaign issues a tracked coupon → redeemed at order → ROI).
3. **Daily Growth Brief** (7 AM: yesterday vs baseline + top-3 one-tap actions with predicted ₹).
4. **Weekly Impact Report** (attributable revenue + retention + ROI multiple — the renewal engine).

Outcome: the owner sees, every morning, what happened and the 3 highest-value actions to take
today; and can attribute rupees to Zordic every week.

## Ground rules (do NOT violate — Phase 0 guarantees + product discipline)
- **Work ONLY in `data\`** (`data\server.js`, `data\db.js`, `data\routes\*.js`, `public\*`).
  The root `server.js` monolith is legacy — never edit it.
- **Realtime:** always use `emitToBranch(branchId, event, payload[, {public}])` from `data\server.js`.
  Never reintroduce a bare `io.emit(...)` (that was the Phase 0 cross-tenant leak, BUG-1).
- **Auth:** every new STAFF endpoint gets `requireAuth, requireBranchAccess`. Agency-wide endpoints
  get `requireRole('agency_admin','admin')`. Customer-facing reads stay sanitized (Phase 0 SEC-8).
- **AI discipline (INTENT protocol):** Gemini only PHRASES narratives. All numbers, KPIs, ROI, and
  action selection are computed in deterministic JS. Gemini never writes to the DB and never decides
  money. Always ship a non-Gemini template fallback (system may run without `GEMINI_API_KEY`).
- **Money paths:** before editing `orders.js`/loyalty, add a quick route test; re-run after.
- **Phones:** normalize to last-10-digits everywhere. Add ONE shared `normalizePhone()` in `db.js`
  and use it (there is inline `.replace(/[^0-9]/g,'').slice(-10)` scattered around — consolidate).

## Reuse these existing helpers (don't reinvent)
- `data\db.js`: `getRevenueStats`, `getDailyRevenue`, `getTopItems`, `getOrCreateCard`,
  `getLoyaltyCard`, `awardPoints`, `awardBonusPoints`, `recordVisit`, `getCustomerVisits`,
  `buildCustomerProfile`, `getAtRiskCustomers`, `getUpcomingBirthdays`, `getProfitAndLoss`,
  `getAdminBillingReport`, `audit`, `raw()`.
- `data\server.js`: `emitToBranch`, `getBranchData`/`writeBranchData`, `runAutoPilotCampaign`,
  `getLoyaltyTier`, the `routeCtx` object, `waApi` (WhatsApp Cloud API sender).
- `data\backup.js`: `scheduleDaily()` — copy its "ms-until-target-hour then setInterval(24h)"
  pattern for the 7 AM brief and weekly report schedulers.
- `data\routes\loyalty.js`: birthday-campaign; `ctx.sendPushToPhone`.
- `data\routes\marketing.js`: AI campaign suggest/approve, offers approve, google-review sync.
- `data\routes\orders.js`: order create + `awardPoints` on `served`.
- `data\whatsapp-api.js`: `sendMessage(phoneNumberId, accessToken, to, text)`.

---

## WP0 — Prep & safety (do first)
- Commit Phase 0 first so there's a checkpoint (or create a working branch).
- Copy `data\cafe_hq.db` → `data\cafe_hq.db.pre-phase1.bak`.
- Add a shared `normalizePhone(p)` to `db.js` and export it; add to `routeCtx`.
- Confirm server boots clean on a test port (`node data\server.js`).
**Verify:** clean boot; `/api/businesses` returns the 4 real tenants; `owner` login works.

## WP1 — Unified customer record (the risky one — do carefully)
**Goal:** one canonical per-tenant customer row as the single source of truth; kill tier drift.

New table in `db.js` (`customers_v2` — new name so migration doesn't clobber legacy `customers`):
```
customers_v2(
  id TEXT PK, business_id TEXT, phone TEXT,           -- phone = last 10 digits
  name TEXT, tier TEXT, visits INT, total_spent REAL,
  points INT, stamps INT, birthday TEXT,              -- MM-DD normalized
  tags TEXT (json), first_seen DATETIME, last_seen DATETIME,
  avg_rating REAL, feedback_count INT,
  UNIQUE(business_id, phone))
```
- ONE tier function: reuse `db.loyaltyTier(points, visits)` (Phase 3) as canonical; delete/ignore
  `server.js getLoyaltyTier` divergence and the `upsertCustomer` tier-overwrite path.
- **Migration `migrateCustomersV2()`** (idempotent, dry-run flag): read + merge, keyed by
  normalized phone, from all four legacy sources per branch: `customer_profiles.json`, `crm.json`,
  SQLite `customers`, SQLite `loyalty_points` (+ derive visits/spend from `customer_visits` and paid
  `orders`). Highest-signal wins (max visits, max points, non-null name/birthday). Dry-run prints
  per-branch counts and a diff; live run writes `customers_v2` and logs a summary via `audit`.
- Add db helpers: `getCustomer(bizId, phone)`, `listCustomers(bizId)`, `upsertCustomerV2(...)`,
  `getCustomerTimeline(bizId, phone)` (chats + orders + visits + coupons + feedback, merged, sorted).
- **Compatibility layer:** refactor CRM read endpoints (`GET /businesses/:id/crm` in marketing.js,
  at-risk + insights in server.js) to read from `customers_v2`. Keep writing legacy JSON in parallel
  for one release (dual-write) so nothing else breaks; TODO to remove dual-write in Phase 2.
**Verify:** run migration dry-run on the COPY db; merged counts ≈ union of sources with no phone
duplicates; CRM tab still renders; a known VIP keeps VIP tier (BUG-5 stays fixed).

## WP2 — Coupon & attribution engine (the money-proof)
**Goal:** every offer/campaign carries a unique code; redemption ties revenue back to its source.

New `coupons` table in `db.js`:
```
coupons(
  id TEXT PK, business_id TEXT, code TEXT UNIQUE,
  source_type TEXT,        -- ai_campaign|offer_request|feedback5|review|winback|birthday|autopilot
  source_id TEXT,          -- campaign/offer id
  customer_phone TEXT,     -- null = broadcast/generic
  discount_type TEXT,      -- percent|flat|free_item
  discount_value REAL,
  status TEXT,             -- issued|redeemed|expired
  issued_at DATETIME, expires_at DATETIME,
  redeemed_at DATETIME, order_id TEXT, redeemed_revenue REAL)
CREATE INDEX idx_coupons_biz ON coupons(business_id, status);
```
- Helpers: `issueCoupon({...})` (readable unique code, e.g. `WIN-4F2A`), `validateCoupon(bizId, code)`,
  `redeemCoupon(bizId, code, orderId, orderTotal)`, `getAttributionReport(bizId, {from,to})`
  (per source_type/source_id: issued, redeemed, redemption %, attributed revenue, discount cost,
  ROI = revenue ÷ cost).
- **Issue coupons at every offer/campaign path** (replace today's bare string codes like
  `THANKYOU15`/`REVIEW15` with tracked coupons): AI campaign approve (marketing.js), offer approve
  (marketing.js), 5-star feedback (server.js FEEDBACK flow + marketing.js web feedback), google-review
  verified (marketing.js), at-risk win-back (server.js send-offer), autopilot campaign
  (server.js `runAutoPilotCampaign`), birthday-campaign (loyalty.js).
- **Redeem at order time:** `orders.js POST /orders` accepts optional `couponCode`; validate → apply
  discount to server-computed totals → mark redeemed with `order_id` + revenue. Also add
  `POST /businesses/:id/coupons/validate` (staff) so the billing UI can check before finalizing.
- Endpoint `GET /businesses/:id/attribution?from&to` (staff) → the ROI rollup.
**Verify:** approve a campaign → coupon `issued`; place an order with that code → `redeemed` with
order_id + revenue; attribution report shows revenue and ROI > 0 for that source.

## WP3 — Metrics / instrumentation helpers (feeds WP4 & WP5)
Add deterministic helpers in `db.js` (all business-scoped):
- `getWeekdayBaseline(bizId, date)` — avg paid revenue + order count for the same weekday over the
  prior 4 weeks (built on `getDailyRevenue`).
- `getRepeatVisitRate(bizId, windowDays)` and `getSecondVisitConversion(bizId)` — from
  `customer_visits`/`orders`.
- `getWinbackRate(bizId, {from,to})` — of at-risk customers contacted, how many returned (join
  coupons `winback` → subsequent paid order).
- `getNewVsReturning(bizId, date)`.
Instrument as you build so North-Star metrics (repeat-visit ↑, 2nd-visit >35%, win-back >10%,
campaign ROI >4×) are all queryable.

## WP4 — Daily Growth Brief (the "AI employee" moment)
**Goal:** each morning, one card + WhatsApp: yesterday vs baseline + top-3 approvable actions.
- Table `daily_briefs(id, business_id, brief_date, payload_json, created_at, UNIQUE(business_id,brief_date))`.
- `computeDailyBrief(bizId)` (deterministic): yesterday revenue vs `getWeekdayBaseline` (with %+arrow),
  order count, new vs returning, attributed revenue + redemptions yesterday, at-risk count today,
  upcoming birthdays today, top item, slow-day flag. Then build **top-3 recommended actions**, each
  `{id, title, detail, predictedValue, actionType, params}` scored by expected ₹:
  - "Send win-back to N lapsed regulars — expected ₹X" (N×returnRate×avgTicket×repeatFactor)
  - "Birthday offers to M customers today — expected ₹Y"
  - "Slow-day campaign for <today> — expected ₹Z" (if slow-day)
  Pick the 3 highest predicted values that are actionable today.
- `generateBriefNarrative(brief)` — Gemini phrases the computed numbers into 2–3 warm sentences;
  template fallback when no Gemini. (INTENT discipline: numbers already fixed.)
- Endpoints (staff): `GET /businesses/:id/growth/brief` (today, compute-on-read + cache in table);
  `POST /businesses/:id/growth/brief/actions/:actionId/approve` → dispatches the action by
  `actionType` **reusing existing engines** (win-back → server.js at-risk send-offer + `issueCoupon`;
  birthday → loyalty.js birthday-campaign + coupons; slow-day → `runAutoPilotCampaign`), and marks the
  action done. One tap = real campaign + tracked coupons.
- **Schedule + deliver:** `scheduleDailyBriefs()` in `server.js` `server.listen` callback, 7 AM local
  (copy `backup.js` timing). Per branch: compute+store, `emitToBranch(id,'growth_brief',...)`, and if
  the branch has WhatsApp Cloud API creds, `waApi.sendMessage(...)` the brief to the owner.
**Verify:** `GET /growth/brief` → sensible KPIs + 3 actions with ₹ values; approve one → underlying
campaign fires + coupons issued + socket only reaches that branch's room.

## WP5 — Weekly Impact Report (the renewal engine)
- Table `weekly_reports(id, business_id, week_start, payload_json, created_at)`.
- `computeWeeklyImpact(bizId)`: attributable revenue (from `coupons`), retention movement
  (`getRepeatVisitRate` WoW), win-back rate, campaign ROI, and **ROI multiple vs subscription price**
  ("Zordic earned you ₹23,400 — 4.7× your plan").
- `GET /businesses/:id/growth/weekly` (staff); schedule Monday ~8 AM; deliver via WhatsApp + socket.
**Verify:** report renders with attributable revenue and an ROI multiple; agency HQ can also pull it.

## WP6 — Front-end Growth surfaces (`public\manager.html`, keep existing styling)
- **Overview tab, top:** "Today's Growth Brief" card — yesterday KPIs vs baseline (arrows), attributed
  revenue, and the 3 action buttons (**Approve** → POST approve endpoint, then toast + refresh). The
  manager socket already joins its room (Phase 0), so just add a `socket.on('growth_brief', …)`.
- **AI Campaigns tab (or new "Growth" tab):** Attribution / Campaign-ROI table from `GET /attribution`.
- **Orders / new-order flow:** a "Coupon code" field → calls `POST /coupons/validate`, shows the
  discount, and passes `couponCode` to order create. (Redemption is staff-side only — Phase 0 SEC-7.)
- **Weekly Impact card** on Overview (or Owner portal `public\portal.html`).
**Verify:** card shows real numbers; Approve triggers the campaign; ROI table populates; coupon field
applies a discount at billing; no cross-tenant socket bleed (open two branches, confirm isolation).

## WP7 — End-to-end verification, demo seed, docs
- Seed a demo scenario on the COPY db (customers with lapses + birthdays + past orders) so the brief
  and reports show non-trivial numbers.
- Full path test: campaign approved → coupon issued → order redeems it → attribution + daily brief +
  weekly report all reflect the revenue; win-back approve → coupon → return visit → win-back rate ↑.
- Re-run Phase 0 smoke checks (auth 401s, tenant socket isolation, public API sanitized) — nothing
  regressed.
- Update `docs\ZORDIC_MASTER_PLAN.md` (mark Phase 1 done) and the memory files with Phase 1 status.
  Note Phase 2 follow-ups (remove customer dual-write; OTP self-serve redemption; churn scoring;
  WhatsApp consent/template compliance).

## Execution order & checkpoints
WP0 → WP1 (migrate + verify on copy) → WP2 → WP3 → WP4 → WP5 → WP6 → WP7.
Commit after each WP so every step is a rollback point. Keep the pre-phase1 DB backup until WP7 passes.
