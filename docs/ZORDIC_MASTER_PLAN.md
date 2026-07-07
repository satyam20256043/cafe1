# ZORDIC CALIFORNIA — Master Plan
**Audit · Market Analysis · Product Strategy · Roadmap**

Version 1.0 — 6 July 2026
Scope: Steps 1–3 of the product charter (understand → research → philosophy), plus the prioritized build roadmap (Steps 4–9) and the measurement system (Step 10 / final success metric).

---

## 0. Executive Summary

Zordic California is a feature-rich prototype with the **right product DNA** — it is already retention-first (loyalty, win-back, birthday campaigns, review gamification, AI chat) rather than POS-first, which is exactly where the market is heading. But it is currently **demo-grade**: 55 documented defects including 8 critical security holes, two parallel codebases, four overlapping customer data stores, three conflicting loyalty-tier schemes, and real-time events that broadcast every tenant's data to every connected browser. It cannot be rented to a single paying café in its current state.

**The market opening (one sentence):** In India, the POS layer is commoditized (Petpooja won distribution), the engagement layer is campaign *tooling* that still makes the owner do the thinking (Reelo), and nobody has shipped an **autonomous AI growth manager** that owns the customer conversation (WhatsApp), owns the transaction surface (QR ordering + reservations), runs lifecycle marketing itself, and reports *attributable rupees* back to the owner every week. Zordic already has all the raw ingredients for this. No competitor has all four.

**Top 5 moves, in order:**
1. **Phase 0 — Trust & Isolation (2 weeks):** fix the 8 critical security holes + cross-tenant socket leak, rotate exposed keys, freeze the legacy codebase. Non-negotiable before the first paying tenant.
2. **Build the attribution loop:** every campaign carries a coupon code that is tracked through to a paid order. This single feature converts Zordic from "nice dashboard" to "provable ROI machine" — and is the sales engine for the SaaS itself.
3. **Ship the Daily Growth Brief:** a 7 AM WhatsApp message + dashboard card telling the owner what happened yesterday and the 3 highest-value actions today, each approvable with one tap. This is the "AI employee" experience.
4. **Consolidate the data model** (one customer record, one loyalty scheme) so the AI's recommendations are trustworthy.
5. **Demote accounting, kill legacy surfaces:** P&L/GST/expenses become data feeds for profit advice, not a product; legacy pages and the Puppeteer WhatsApp mode get removed.

---

# PART A — SYSTEM AUDIT (Step 1)

Grounded in: direct reads of `db.js`, `auth.js`, `backup.js`, `whatsapp-api.js`, root `server.js`, route inventory, and the full system manual (`zordic_system_manual.md`, ~6,800 lines) including its Chapter 41 defect catalogue. Two codebases exist; **`data\server.js` + `data\routes\*.js` (10 modules) is the current one** (port 3010, what `RESTART.bat` runs). The root `server.js` (3,119-line monolith) is legacy.

## A1. Existing Features (inventory)

| Surface | Route | What it does today |
|---|---|---|
| **Customer café page** | `/cafe/:id` | Digital menu, offers, per-branch theming, loyalty card, reservation + feedback forms, PWA install, push notifications, AI chat widget (Gemini `gemini-2.0-flash` + Hinglish/Hindi/English rule fallback) |
| **QR table ordering** | `/order/:id` | Browse menu → cart → order to kitchen, live status tracking via Socket.io, Razorpay or cash |
| **Kitchen Display** | `/kitchen/:id` | Live order queue, six-stage status pipeline, sound alerts |
| **Manager dashboard** | `/manager/:id` | 15+ tabs: reservations, CRM + at-risk customers, menu CRUD, feedback with AI-drafted replies, AI campaign suggestions, custom-offer approvals, chat simulator, orders/revenue, table-QR generator, loyalty admin, expenses, settings, staff |
| **Owner portal** | `/portal/:id` (+ legacy `/owner/:id`) | Multi-branch overview, revenue/P&L/GST tabs, billing status, chat history |
| **Agency HQ (you)** | `/hq` (+ legacy `admin.html`) | Tenant registry, onboarding, plan/subscription control, leads from marketing site, cross-tenant billing report |
| **Platform** | — | JWT auth (6 roles) + branch-access middleware, plans (`starter/pro/enterprise` with feature flags), Razorpay orders + webhook, per-branch WhatsApp Cloud API, Auto-Pilot low-traffic campaigns (12 h scheduler, 48 h per-customer cooldown), daily 2 AM SQLite backups (keep 7), audit log, self-serve onboarding (`/onboard`), marketing site (`website.html`) with lead capture |

**AI usage today:** intent classification + reply drafting via the `INTENT:` marker protocol (Gemini classifies, deterministic code acts — Gemini never writes to the DB), AI campaign suggestions, AI feedback-reply drafts, AI win-back offer generation, customer insight summaries.

## A2. Strengths (protect these — do not rewrite)

1. **Retention-first feature set.** Loyalty points *and* stamps, tier ladders, birthday campaigns, at-risk detection, review gamification (THANKYOU15/REVIEW15 coupons), win-back offers. Competitors sell these as add-ons; Zordic has them native.
2. **The `INTENT:` protocol is the correct AI architecture.** LLM does language understanding; auditable local code performs every state change. This is production-grade thinking most AI prototypes lack. Extend it — never bypass it.
3. **India-fit is real, not cosmetic.** Hinglish detection, ₹ pricing, GST reports, Razorpay, WhatsApp-first. US platforms cannot cheaply replicate this.
4. **Zordic owns the transaction surface.** QR ordering + reservations + loyalty in one system means campaign→visit→spend attribution needs **no POS integration**. This is Reelo's structural weakness and Zordic's structural advantage.
5. **Modular `routeCtx` design** in the current codebase (10 route modules, dependency-injected context) — a sane extension point.
6. **Real-time backbone** (Socket.io) already wired into kitchen, ordering, dashboards.
7. **The manual itself** — a 6,800-line living document with a defect catalogue. Few startups have this asset. Keep it updated as part of definition-of-done.

## A3. Weaknesses, Duplicated Logic, Technical Debt

| # | Debt item | Detail | Consequence |
|---|---|---|---|
| D1 | **Two codebases** | Root `server.js` monolith vs `data\server.js` + routes | Fixes land in one, not the other; confusion about what runs |
| D2 | **Four customer stores** | SQLite `customers`, SQLite `loyalty_points`, `customer_profiles.json`, `crm.json` per branch | No single source of truth; AI recommendations built on inconsistent data |
| D3 | **Three loyalty-tier schemes** | `server.js getLoyaltyTier(visits)`, `db.loyaltyTier(points, visits)`, walk-in CRM variant | Same customer shows different tiers on different screens |
| D4 | **In-memory conversation state** | `userStates{}` lost on restart | Mid-reservation customers get orphaned; blocks multi-instance scaling |
| D5 | **Duplicated auth scaffolding** | JWT sign/verify + staff loading duplicated in `server.js` and `auth.js`; `stmts.getStaffByUsername` missing `business_id` filter (BUG-7) | Cross-tenant login bug waiting to happen |
| D6 | **Legacy duplicate pages** | `admin.html` vs `hq.html`; `owner.html` vs `portal.html`; `manager-client.js` fake `doLogin()` | Six visual styles, duplicated logic, one of them is a security hole (SEC-6) |
| D7 | **Route collisions** | `feedback.js` vs `marketing.js` register overlapping endpoints; ~10 inline "debugger" endpoints in `server.js` | Unpredictable which handler wins; refactoring risk |
| D8 | **Two WhatsApp stacks** | `whatsapp-web.js` (Puppeteer/QR, fragile, ToS-risky) alongside Cloud API | Chrome dependency, breakage, ban risk for tenants |
| D9 | **JSON file persistence for hot data** | Full-file rewrite per update, no locking | Race conditions under concurrent orders; data loss risk |
| D10 | **Schema drift bugs** | `logBackup()` writes columns that don't exist (BUG-2) — backup logging silently broken; `audit_log.staff_id` type mismatch (BUG-11) | Silent failures in exactly the systems you rely on in a crisis |

## A4. Security Issues — rental blockers

From the defect catalogue (all verified against code) plus two found in this audit:

| ID | Issue | Severity |
|---|---|---|
| SEC-1 | Hardcoded admin token `cafehq_admin_secret` in publicly served `admin.html` | CRITICAL |
| SEC-2 | Live Razorpay key rendered in admin UI DOM | CRITICAL |
| SEC-3 | JWT secret falls back to a publicly known default string | CRITICAL |
| SEC-4 | `GET /api/leads` (all sales leads) has **no auth** | CRITICAL |
| SEC-5 | `POST /api/businesses/:id/subscription` lets **any staff** grant themselves free enterprise plan | CRITICAL |
| SEC-6 | Client-side `doLogin()` with `admin/admin123`, bypassable via localStorage | CRITICAL |
| SEC-7 | Loyalty redemption endpoints unauthenticated — anyone with a phone number can drain a customer's points | CRITICAL |
| SEC-8 | WiFi passwords returned by public `GET /api/businesses` | CRITICAL |
| BUG-1 | `io.emit()` broadcasts every tenant's orders/CRM/chat to every connected client | CRITICAL (tenant isolation) |
| NEW-1 | **Real Gemini API key committed in `.env`** (folder has a `.git` repo) — rotate at aistudio.google.com | CRITICAL |
| NEW-2 | `data\CREDENTIALS.txt` and `stafflogins.html` (staff passwords listed for "testing") shipped with the app | CRITICAL |

**Hard rule: no paying tenant until every row above is closed.** A single incident (one café reading another's customer list) ends the business's reputation before it starts.

## A5. Scalability Assessment (for AWS + rental model)

- **SQLite (better-sqlite3, WAL)** is *fine* to roughly 50–100 tenants on one node. It is not the bottleneck. Don't rewrite it prematurely.
- **The JSON files are the real problem**: unlocked concurrent full-file rewrites of `orders`-adjacent data will corrupt under real load; every write also triggers a global `io.emit`.
- **Sockets**: no rooms (tenant leak + O(all-clients) noise); no Redis adapter (blocks >1 process).
- **State**: conversation state and WhatsApp status in process memory → cannot run 2 instances, restarts lose sessions.
- **Schedulers**: `setInterval` inside `server.listen` — first Auto-Pilot run is 12 h after boot, none if restarted often; no catch-up, no idempotency.
- **Hygiene**: CORS `*`, no request validation layer, no rate limiting (except login), secrets committed, no health endpoint, no structured logs.

**Right-sized path (don't over-engineer):**
- *Stage 1 (launch, ≤50 cafés):* one EC2/Lightsail box, PM2, Caddy/nginx TLS, SQLite + Litestream replication to S3, Socket.io rooms, JSON→SQLite migration for hot domains, CloudWatch + `/healthz`.
- *Stage 2 (>100 cafés or 2nd instance):* Postgres (RDS), Redis (socket adapter + job queue for WhatsApp sends), horizontal scale.

## A6. UI/UX Issues

- **Six distinct visual palettes/style systems** across pages; no shared design system. `manager.html` is a 196 KB single file (the repo even contains `clean_manager.js` — a script written just to remove its duplicated CSS blocks).
- Dashboards are **data-dense tables, not decisions** — the owner must interpret raw numbers, which violates the product philosophy directly.
- `alert()` used for errors; inconsistent brand naming in UI (Café Command HQ / Zordic California / CaféGrow); `window._branchName` bug shows "ZORDIC CA" on every loyalty card (BUG-4); broken notification icon in KDS (BUG-3).
- Mobile: customer pages are PWA-ready (good), staff dashboards are desktop-first — but Indian café owners live on their phones. The **owner experience must be phone-first** (and the Daily Brief lands on WhatsApp precisely for this reason).

## A7. Missing Functionality (vs. the growth-platform goal)

1. **Campaign → revenue attribution** — the single most important gap. Nothing links an offer sent to an order placed.
2. **Owner daily digest / recommendations** — no proactive surface at all; everything is pull, not push.
3. **Unified customer timeline** (chats + orders + campaigns + feedback in one view).
4. **WhatsApp compliance layer** — Meta requires pre-approved templates + opt-in for business-initiated messages; there is no consent tracking, template manager, quiet hours, or frequency caps. This is a legal/ban risk *and* a feature.
5. **Menu profitability** — no COGS/margin input, so "which items make me money" is unanswerable.
6. **Revenue forecasting** — none.
7. **Self-serve billing automation** — subscriptions are manually set by the agency; no Razorpay recurring billing, no dunning, no trial-expiry automation.
8. **Onboarding friction** — no menu import (a photo-to-menu Gemini Vision flow would make onboarding a 10-minute job).
9. **Referral/acquisition engine** — acquisition today is only review gamification; no "bring a friend" tracked offers.

---

# PART B — MARKET ANALYSIS (Step 2)

## B1. Competitor Landscape

| Platform | Focus / market | Strengths | Weaknesses & the gap Zordic exploits |
|---|---|---|---|
| **Toast** (US) | Full POS ecosystem | ToastIQ AI assistant (Oct 2025) grounded in own data, can act (86 items, stock); loyalty across all surfaces | US-only; hardware lock-in; loyalty locked in **$185/mo Marketing Essentials bundle** on top of base POS; AI is *operations*-first, not customer-conversation-first |
| **Square for Restaurants** (US) | SMB POS | Cheap entry, clean UX, easy setup | Generic retention, weak restaurant CRM depth, no WhatsApp, minimal India presence |
| **Lightspeed** | Multi-location POS | Inventory + multi-location analytics | Complex, expensive, not an India player; ERP-leaning |
| **Oracle MICROS/Simphony** | Enterprise chains/hotels | Scale, integrations, reliability | Massive cost, dated UX, months-long deployments — irrelevant to indie cafés |
| **Petpooja** (India, SMB leader) | POS + billing | Huge distribution, GST billing, aggregator integrations, effective ₹1.2k–12k/mo | **Loyalty/CRM/WhatsApp are paid add-ons**; no real AI; dashboards not decisions; dated UX; modular pricing balloons real cost |
| **Posist / Restroworks** (India→global) | Enterprise chain management | Strong chain ops, inventory, enterprise CRM | Premium ERP pricing; overkill and over-complex for a single café |
| **Loyverse** | Free POS | Free, simple, basic loyalty | No marketing automation, no AI, monetizes via add-ons; a lead-gen commodity |
| **SpotOn** (US) | SMB POS + marketing | Decent built-in marketing | US-only, POS-first, no conversational AI |
| **Reelo** (India — closest competitor) | Loyalty/CRM/engagement layer | Behaviour-based campaigns, WhatsApp templates + carousels, memberships/prepaid wallets, POS integrations | **Doesn't own the ordering surface** (depends on POS integrations for spend data); campaign *tooling* — the owner still designs and drives; no AI receptionist answering customers; no autonomous operation |
| **AI-first US wave** (Punchh, Ovation, Momos, Owner.com, Slang.ai/Loman voice) | Point solutions | Deep in one slice (enterprise loyalty / feedback / websites / phone AI) | Fragmented; each is one employee-function; none is India-priced or WhatsApp-native |

## B2. What Everyone Gets Wrong — the Opening

1. **Every platform gives dashboards; owners need decisions.** Even ToastIQ (the best AI in the space) is ops-focused, US-only, and priced for US margins.
2. **The engagement layer and the transaction layer are separate products everywhere.** Reelo needs Petpooja's data; Petpooja sells Reelo's features as dumb add-ons. Zordic natively has both → attribution without integration.
3. **WhatsApp is the retention channel in India in 2026** (even Reelo's own positioning says loyalty conversations are moving to WhatsApp) — but no one has put an *AI that talks back* on that channel. Zordic's chatbot already takes reservations, answers menu questions in Hinglish, and manages loyalty over chat.
4. **Add-on pricing fatigue.** Petpooja and Toast both monetize retention as expensive add-ons. A flat, honest price with provable ROI is a wedge.

**Positioning statement:**
> *Zordic is the AI growth manager your café hires for less than one day of a waiter's salary per month. It answers your customers on WhatsApp, fills your slow days, brings back the ones about to leave you — and shows you exactly how many rupees it earned you every week.*

**Deliberately NOT building (never copy):** full POS billing, inventory management, payroll, aggregator/delivery management, accounting suite. Integrate with Petpooja et al. later (Phase 4) — their POS becomes a data source, not a competitor.

## B3. Pricing Architecture (maps to existing `PLAN_FEATURES`)

| Plan | Price (suggested) | Contents |
|---|---|---|
| **Starter** | ₹1,999/mo | AI receptionist (web chat), digital café page, QR ordering + KDS, loyalty, feedback |
| **Growth** | ₹4,999/mo | + WhatsApp channel, Auto-Pilot lifecycle campaigns, churn radar, Daily Growth Brief, attribution reports |
| **Franchise** | ₹9,999/branch/mo | + multi-branch benchmarking, franchise HQ views, API access, priority support |

Anchors: Petpooja base + loyalty + WhatsApp add-ons lands in the same range with zero intelligence; Toast's loyalty bundle alone is ~₹15,500/mo. Renewal engine = the Weekly Impact Report ("Zordic earned you ₹23,400 this month — 4.7× your subscription"). 14-day trial (the `trialEndsAt` field already exists).

---

# PART C — FEATURE TRIAGE (Step 3: philosophy applied)

Every feature judged against: revenue ↑, profit ↑, retention ↑, repeat visits ↑, CLV ↑, acquisition ↑, owner workload ↓.

| Verdict | Features |
|---|---|
| **KEEP & SHARPEN** (direct business impact) | AI chat + INTENT flows · loyalty engine (after consolidation) · QR ordering + KDS · campaign engine · feedback + review gamification · at-risk detection · reservations · agency HQ + plans/billing · onboarding flow |
| **IMPROVE** (right idea, weak execution) | Auto-Pilot → full lifecycle engine with attribution · CRM → one unified customer record + timeline · analytics tabs → recommendation cards ("do this today") · AI campaign suggestions → tied to predicted ₹ value |
| **DEMOTE to data-feed** (not a product; feeds profit advice only) | Expenses / P&L / GST reports (keep the data capture — it powers the Profit Advisor — stop building accounting UI) · traffic heatmap (input to staffing hints) |
| **KILL / FREEZE** | Root `server.js` monolith (archive) · `admin.html` (merge into `hq.html`) · `owner.html` (merge into `portal.html`) · `manager-client.js` fake login · `stafflogins.html` + `CREDENTIALS.txt` · `whatsapp-web.js` Puppeteer mode · service-worker background-sync stub (no-op) |

---

# PART D — ROADMAP (Steps 4–7, with impact estimates)

Impact estimates assume a typical single café: ~1,000 known customers, ₹250 average ticket, ~60 orders/day. They are directional, not promises — Phase 1's attribution loop is what makes them *measurable*.

## Phase 0 — Trust & Isolation — ✅ COMPLETED 6 July 2026

All items below were implemented and smoke-tested on 6 July 2026 (see git history).
Additional issues found and fixed during implementation, beyond the manual's catalogue:
- **Menu wipe on restart**: `initializeBusinessFiles` overwrote every branch's `menu.json` with the demo menu on every boot (missing existence guard) — fixed.
- **`GET /api/setup/seed-owner`**: unauthenticated endpoint reset every owner password to `cafe1234` — removed.
- **`sendPushToPhone` ReferenceError** in orders.js broke kitchen status updates for orders with a phone number — fixed via shared ctx.
- **`runAutoPilotCampaign` / `getLoyaltyTier` ReferenceErrors** in marketing.js broke the campaign trigger endpoint and local campaign suggestions — fixed via routeCtx.
- **`start_whatsapp` socket event** called an undefined function (process-crash on click) — replaced with a Cloud-API guidance message.
- **Unauthenticated tenant-suspension endpoint** (`POST /api/agency/clients/:id/status`), agency client list, franchise-group update, google-review approve/reject, reservations list, AI reply-draft, at-risk send-offer, customer insights — all now require the appropriate JWT.
- **Public API sanitization**: unauthenticated `GET /api/businesses[/:id]` now returns a whitelist (id, name, location, timings, contact, map, wifi, review, status, theme, brandColor, tables); owner PII and subscription state require a staff token. WiFi is intentionally kept public because the café page displays it to customers by design — owners control the field.
- **Customer self-redemption** of loyalty rewards moved to counter-redemption (staff JWT required on redeem endpoints); cafe.html buttons now instruct the customer to show the card at the counter. Phase 2 may restore self-serve via OTP.
- **Socket rooms**: three-tier model — `biz:<id>:public` (order tracking, no auth), `biz:<id>:staff` (JWT for that branch), `agency` (admin JWT). `trigger_campaign_broadcast` now requires a branch-staff token.
- **JWT secret rotated** to a 62-char random value; boot now fails fast on missing/short/default secrets.
- **Git hygiene**: `.gitignore` added; node_modules + WhatsApp session untracked (staged); `.env`/credentials were never in git history. `stafflogins.html`, `data/CREDENTIALS.txt`, dead `manager-client.js` deleted.

Original Phase 0 scope (for reference):

### Phase 0 scope (as planned) — *blocker for revenue*

Close SEC-1…8, NEW-1, NEW-2; Socket.io rooms per `businessId` (BUG-1, BUG-10); fix silent-corruption bugs (BUG-2 backup logging, BUG-5 tier downgrade, BUG-7 tenant-unsafe staff lookup, BUG-11); enforce strong `JWT_SECRET` at boot (fail fast); rotate + de-commit the Gemini key; declare `data\` codebase canonical and archive the monolith; add request validation (zod or hand-rolled) + rate limiting; secret-scan git history.
**Impact:** enables the business to exist. Revenue impact = 100% of it.

## Phase 1 — The Attribution Loop + Daily Growth Brief (Weeks 3–6) — *the differentiator*

1. **Unified customer record**: merge the four stores into one SQLite-backed record; one loyalty tier function; normalized phones; migration script with dry-run.
2. **Attribution**: every campaign/offer generates a unique coupon code → redeemed at order time → campaign ROI table (sent / redeemed / revenue / cost).
3. **Daily Growth Brief** (7 AM, WhatsApp + dashboard card): yesterday's revenue vs 4-week same-weekday baseline, anomaly callouts, top 3 actions each with predicted value and a one-tap **Approve** (e.g., "Send win-back to 14 customers who used to visit weekly — expected ₹2,100"). Gemini writes the narrative; deterministic code computes the numbers (INTENT-protocol discipline).
4. **Weekly Zordic Impact Report**: attributable revenue, retention movement, ROI multiple — doubles as your renewal/sales engine.

**Impact:** win-back alone (200 at-risk × 10% return × ₹250 × ~2 visits) ≈ ₹10k/mo/café; birthday campaigns typically redeem 15–25%; owner saves ~5 h/week; your SaaS churn drops because value is visible. **Highest ROI phase in the plan.**

## Phase 2 — Retention Autopilot 2.0 (Weeks 7–12)

RFM-based churn scoring (explainable, no ML infra; Gemini narrates the "why") · lifecycle ladders (welcome → 2nd-visit nudge → regular → VIP → at-risk → lost, each with default offers) · WhatsApp compliance layer (opt-in consent, template manager, quiet hours, frequency caps) · A/B offer testing · plain-language segment builder ("students who come after 5pm").
**Impact:** repeat-visit rate is the north-star input; 2nd-visit conversion is the single highest-leverage number in café economics (a +10% improvement compounds through every later stage). Compliance layer removes the account-ban existential risk.

## Phase 3 — Profit Advisor (Months 4–5)

Menu engineering: per-item margin (owner enters COGS or accepts AI-estimated %) → Stars/Plowhorses/Puzzles/Dogs quadrant with concrete actions ("raise Cold Coffee ₹10 — demand is inelastic here", "bundle the Dog with a Star") · price-change tracking to verify effect · staffing hints from the traffic data already collected · simple weekly revenue forecast (seasonal baseline + trend).
**Impact:** menu engineering classically moves gross margin 2–5 points; this phase converts the demoted accounting data into profit decisions — the difference between "not an accounting product" and "wasted data".

## Phase 4 — Scale & Distribution (Month 5+)

AWS Stage-1 deployment (Part E) · Razorpay **subscription** automation + webhooks + dunning + trial expiry (kills your manual admin work) · self-serve onboarding with **menu-photo import via Gemini Vision** (10-minute setup) · franchise benchmarking ("Indiranagar's repeat rate is 12% above Koramangala — here's why") · referral engine (tracked friend-offers) · public API + Petpooja/POS integrations (their POS becomes your data source) · native app wrapper only if PWA proves insufficient.

*Step 10 loop: after each phase, re-run the audit, update the manual and this document, re-prioritize.*

---

# PART E — ARCHITECTURE EVOLUTION (no big-bang rewrite)

1. **Canonical repo**: promote `data\server.js` + `data\routes\` to project root in a clean git repo (no secrets in history); archive the monolith.
2. **Persistence**: SQLite stays for launch. Migrate JSON→SQLite *per domain, in this order*: customers/CRM → campaigns/offers → settings → menu → the rest. Litestream → S3 for continuous backup. Postgres only at Stage 2 (>100 tenants or 2nd instance).
3. **Conversation state** → SQLite table (survives restarts; unblocks horizontal scale; enables "resume where the customer left off").
4. **Sockets**: rooms now; Redis adapter at Stage 2.
5. **Jobs**: replace `setInterval` with a small scheduler table (idempotent runs, catch-up after restart, per-branch send windows like "4 PM local").
6. **Config**: env-validated at boot; refuse to start on default JWT secret or missing keys.
7. **Observability**: pino structured logs, `/healthz`, CloudWatch alarms; every WhatsApp send and campaign logged with outcome.
8. **Testing**: keep the black-box `verify.js` style; add route tests for the money paths (orders, billing webhook, loyalty redemption, subscription changes) before touching them.

---

# PART F — NORTH-STAR METRICS (final success metric)

**Platform north star:** *median attributable monthly revenue per café ≥ 5× subscription price.*

| Metric | Target | Why |
|---|---|---|
| 30-day repeat-visit rate | +20% vs café's pre-Zordic baseline | Retention is the product's core promise |
| 2nd-visit conversion (new → returning) | >35% | Highest-leverage number in café economics |
| At-risk win-back rate | >10% of contacted | Direct revenue, fully attributable |
| Campaign ROI (revenue ÷ discount cost) | >4× | Keeps offers profitable, not margin-burning |
| Owner minutes-in-app per week | **Decreasing** | The AI-employee promise: less work, not more dashboards |
| Tenant (SaaS) churn | <3%/mo | Impact Report is the renewal engine |

Instrument from day 1: every feature ships with its own measurement, or it doesn't ship.

---

## Market-research sources

- [Petpooja Pricing 2026 — DineOpen](https://www.dineopen.com/blog/petpooja-pricing-plans-2026.html) · [Petpooja review & hidden fees](https://www.dineopen.com/blog/petpooja-review-2026) · [Restaurant POS cost India 2026 — Codingclave](https://codingclave.com/guides/restaurant-pos-software-cost-india-2026) · [Top Petpooja alternatives — OrderIt](https://orderitnow.in/blog/top-10-best-petpooja-alternatives-india-2026/)
- [Reelo](https://reelo.io/) · [Reelo WhatsApp marketing](https://reelo.io/whatsapp-marketing) · [Reelo loyalty](https://reelo.io/loyalty) · [8 best loyalty apps India 2026 — Reelo blog](https://reelo.io/blog/8-best-loyalty-apps-for-restaurants-in-india-2026-edition/) · [Restaurant marketing automation ROI — SaaS Hero](https://www.saashero.net/customer-retention/restaurant-tech-marketing-automation-2026/)
- [Toast launches ToastIQ](https://pos.toasttab.com/news/toast-launches-toastiq-superpower-future-of-restaurants) · [Toast Q1 2026 AI trends](https://pos.toasttab.com/blog/data/q1-2026-restaurant-ai-pos-trends) · [Toast connected POS + guest engagement — RTN](https://restauranttechnologynews.com/2026/06/toast-advances-restaurant-operations-with-connected-pos-ai-and-guest-engagement-technology/) · [Toast AI competition analysis — RTN](https://restauranttechnologynews.com/2025/12/toast-signals-next-phase-of-restaurant-technology-competition-with-expanded-focus-on-ai-driven-operations/) · [Best restaurant loyalty software 2026 — Momos](https://www.momos.com/blog/best-restaurant-loyalty-software)
