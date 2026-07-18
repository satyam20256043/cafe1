# ZORDIC AI RECEPTIONIST GUIDE — v1.0 (for a Sonnet execution session)

Execute work packages **AI0 → AI6 in order, committing after each one**. This guide is
self-contained: read §0–§3 fully before touching any file. Every product decision in §1 was
made explicitly by the user on 2026-07-10 — do **not** re-ask them.

**Status:** AI0 done (commit `01d408b`). **AI3 done out of order** (commit `2090713`,
2026-07-18, user asked for it directly): knowledge.json + Settings form + WhatsApp owner
interview + answer-only-from-facts prompt guardrail — built against the CURRENT keyword+LLM
pipeline, not the AI2 router; when AI2 lands, route FAQ intents through the knowledge pairs.
The AI3 eval step (flipping the FAQ golden cases) is still pending — run it with AI2/AI6.
AI1, AI2, AI4, AI5, AI6 remain.

**Goal in one line:** the WhatsApp AI must feel like a professional, warm human receptionist —
remembers the conversation, knows the café inside out, greets regulars by name, mirrors the
customer's language — while every decision that touches money or the database stays 100%
deterministic.

---

## 0. Context — read first

**Zordic California** is a multi-tenant SaaS for cafés/restaurants, live at `https://zordic.in`
(AWS Lightsail, pm2 app `zordic` in `~/zordic`, Caddy HTTPS; deploy =
`cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`
given to the user as a single line — their SSH terminal corrupts multi-line pastes).

- **Repo**: `github.com/satyam20256043/cafe1` — all real code on **`master`** (GitHub's default
  `main` is an unrelated scaffold; never merge or compare against it).
- **Local**: `C:\Users\SSJ\Desktop\cafe-ai-bot`. Root `server.js` is a frozen legacy monolith —
  all work happens in `data\` (`data\server.js`, `data\db.js`, `data\routes\*.js`) and `public\`.
- **WhatsApp Cloud API inbound+outbound is CONFIRMED WORKING** (2026-07-10). Onboarding playbook:
  `docs\CAFE_WHATSAPP_ONBOARDING.md`. Webhook is app-wide; per-café creds in
  `data/<branchId>/whatsapp_config.json`.
- **The AI pipeline today** (`processCafeBotReplyInner` in `data\server.js`):
  1. state machines (RESERVATION / FEEDBACK slot-filling) →
  2. deterministic keyword nets (escalation categories, discount requests, student offer,
     loyalty, menu price matching, offers list) →
  3. `generateGeminiReply` (model `gemini-2.5-flash`, INTENT tags parsed by `.includes()`) →
  4. `generateLocalConversationalReply` fallback.
  The wrapper `processCafeBotReply(branchId, fromPhone, text, {channel, customerName})` logs
  events AND persists both directions to the SQLite `chat_messages` table — **this table is the
  ready-made source for conversation memory** (schema: business_id, phone last-10, customer_name,
  direction in|out, message, channel, created_at; helper `db.saveChatMessage`).
- **Known weaknesses this guide exists to fix** (all observed live): no conversation memory
  (each Gemini call sees only the current message); keyword brittleness ("discount on cold
  coffee" wasn't recognised until manually added); naive word-list `detectLanguage` (pure-English
  "give me discount please" got a Hinglish reply because "discount" is on the Hinglish list);
  Gemini INTENT misfires are possible (string-tag parsing of free text); knowledge stops at the
  menu (parking/veg/pets/delivery questions escalate or deflect); free-tier Gemini shows
  intermittent `fetch failed` network errors.

## 1. Locked user decisions (2026-07-10 — do not re-ask, do not re-litigate)

1. **Priority = interaction quality**, not new capabilities: "smarter and friendly answers just
   like a professional receptionist". Voice notes, chat ordering, payment links are OUT of scope.
2. **Knowledge base: BOTH authoring modes from day one** — a "Teach your AI" FAQ form in the
   dashboard AND an AI-led interview over WhatsApp that fills the same knowledge base.
3. **AI budget**: stay on free-tier Gemini while dogfooding; the user flips to paid the day the
   first real café signs. Build retries + graceful fallback regardless; make the model name
   env-configurable so the switch is a config change, not a code change.
4. **Persona: owner's choice, named by default.** New setting `assistantName` (sensible default,
   e.g. "Asha"); replies open like "Hi, I'm Asha from Brew Haus ☕". Owner may blank the name →
   AI speaks as the café ("We'd love to see you!"). If a customer asks whether they're talking to
   a human, the AI must say it's the café's AI assistant — never claim to be human.

## 2. Ground rules (violating any of these is a bug)

- **INTENT protocol discipline**: the LLM only CLASSIFIES and PHRASES. Every decision, number,
  discount, coupon, booking and DB write is deterministic JS. Discount ceilings
  (`aiMaxDiscount` per item in menu.json, café-wide in branch-settings.json — note: TWO settings
  files exist; `branch-settings.json` is the managed one, `settings.json` is legacy campaigns) are
  enforced by `aiInstantDiscountReply` and must never be bypassed by any new path.
- **Every Gemini-dependent feature needs a working non-Gemini fallback** (the system must run
  with no `GEMINI_API_KEY`). The keyword nets never get deleted — they become the fallback tier.
- `ctx.db` in route modules is the whole db.js exports object — `db.raw().prepare(...)` for ad-hoc
  SQL, or (preferred) add prepared-statement helpers to db.js and export them.
- New shared server functions go into `routeCtx` in server.js AND the destructure in the route file.
- Realtime: `emitToBranch(branchId, event, payload)` — never bare `io.emit`.
- Test-café protocol (§6) before every commit; stop the local server BEFORE resetting
  `data/businesses.json` (the in-memory array silently rewrites the file otherwise).
- Tool quirks: `preview_logs` doesn't surface `console.warn`; `preview_click` can fail to fire
  handlers — use `element.click()` via `preview_eval`.
- Production data is live — the user may have a real dogfood café connected to real WhatsApp.
  Never wipe production; local test cafés only.

## 3. Work packages

### AI0 — Evaluation harness + golden set (the foundation; do this FIRST)

"100× better" must be measurable. Build a black-box eval that talks to the real pipeline through
`POST /api/businesses/:id/chat` (public endpoint; runs the full brain incl. persistence).

1. `data/tools/ai-eval.js` (standalone node script, never require()d by the server):
   boots nothing itself — expects a locally running server (port 3010), creates a disposable
   café via `/api/onboard`, seeds a small menu + knowledge base + a returning-customer loyalty
   card, then runs every case in `data/tools/golden-set.json` and prints a scorecard.
2. `golden-set.json` — ~150 cases across: greetings; menu/price questions (incl. typos:
   "cold cofee price", "burgr"); Hinglish + Hindi + English variants; discount asks (generic,
   item-directed, over-ceiling); complaints/refunds; payment disputes; large bookings;
   unanswerable (catering/jobs); FAQ questions (parking, veg, pets — will fail until AI3);
   multi-turn sequences (same phone, ordered messages: "how much is the pasta?" → "ok make it
   two" — will fail until AI1); persona checks ("am I talking to a human?").
   Case shape: `{ id, phone, messages: [..], expect: { replyIncludes?/replyMatches?/notIncludes?,
   escalationCategory?, couponIssued?, offerRequestCreated? } }` — side effects asserted via
   sqlite reads and branch JSON files.
3. Two scored tiers: **deterministic cases** (must be 100% — state machines, ceilings,
   escalation keywords) and **LLM cases** (report %; flaky network failures retried once).
4. Run it, record the baseline score in the commit message. This baseline is the "before" that
   every later package is measured against.

**Commit**: `AI0: black-box eval harness + 150-case golden set (baseline scored)`

### AI1 — Conversation memory + language mirroring

1. In `generateGeminiReply`: load the last **10 messages** for (branchId, phone) from
   `chat_messages` (add db.js helper `getRecentChatMessages(businessId, phone, limit)`; phone
   normalized last-10) and render them into the prompt as a `Recent conversation:` transcript
   (customer/assistant turns, oldest first). The current message stays the final "Customer query".
2. Kill the forced-language bug: `detectLanguage`'s word list must stop treating
   English-borrowed words ("discount", "offer", "menu") as Hinglish markers. Gemini gets ONE
   instruction: *mirror the language and script of the customer's most recent message*.
   `detectLanguage` remains ONLY for the deterministic fallback replies' language choice.
3. Deterministic multi-turn guard: state machines (reservation/feedback) still run before
   everything — memory must not break slot-filling ("Rahul" mid-reservation is a name, not a query).
4. Re-run eval: multi-turn cases must now pass; language cases must now pass.

**Commit**: `AI1: conversation memory in Gemini prompt + true language mirroring`

### AI2 — LLM-first intent routing with structured JSON output

Invert the brittle order. New pipeline inside `processCafeBotReplyInner`:

1. State machines (unchanged, always first).
2. **Escalation safety net stays deterministic and pre-LLM**: complaint/refund + payment-dispute
   keyword nets and the large-booking guest threshold keep their guaranteed-trigger position
   (reliability of owner alerts must not depend on an LLM).
3. **LLM router**: one Gemini call with `generationConfig: { responseMimeType: 'application/json',
   responseSchema: {...} }` returning
   `{ intent: 'answer|reservation|offer_request|feedback|loyalty_query|loyalty_redeem|escalate',
     item?: string, category?: string, summary?: string, reply?: string }`.
   - `intent==='answer'` → use `reply` (phrased by the same call — one round-trip, includes
     memory/persona/knowledge context).
   - every other intent → dispatch to the EXISTING deterministic handlers (reservation state
     entry, `aiInstantDiscountReply` ceilings then offer_request escalation, feedback flow,
     loyalty handlers, `triggerEscalation`). The LLM's `item`/`summary` are hints only —
     ceilings and amounts recomputed deterministically.
   - Robust parse: JSON.parse with try/catch; malformed → treat as `answer` with raw text,
     stripped of any INTENT legacy tags.
4. **Retry/backoff**: 2 retries (750ms, 2s) on fetch/5xx errors. Total failure → tier 4.
5. Keyword nets (discount phrases, menu price matching, offers, student, small talk) become the
   **no-Gemini fallback tier** — never deleted, still eval-covered with GEMINI_API_KEY unset
   (add an eval flag `--no-gemini` that asserts the deterministic tier alone still passes its cases).
6. Delete the old free-text `INTENT:` tag parsing once the JSON router is proven by eval
   (the prompt keeps a short rule list, but output is schema-constrained).

**Commit**: `AI2: LLM-first JSON intent router with deterministic execution + keyword fallback tier`

### AI3 — Café knowledge base ("Teach your AI") — form + WhatsApp interview

Storage: `data/<branchId>/knowledge.json` → `[{ id, q, a, updatedAt }]`.

1. **Dashboard form**: new "Teach your AI" panel (Settings tab, above WhatsApp section, or its
   own tab if Settings is crowded — executor's judgment). Pre-seeded with ~12 suggested
   questions, each with an empty answer box: parking; pure-veg or veg+non-veg; delivery
   (Zomato/Swiggy?); payment methods; outdoor seating; AC; kids-friendly; pets; birthday/event
   decorations; group capacity; alcohol; typical wait time at peak. Plus "+ Add your own
   question". Save writes knowledge.json (staff-auth'd endpoints: GET/PUT
   `/api/businesses/:id/knowledge`).
2. **WhatsApp interview**: a "📚 Train over WhatsApp" button beside the form starts it —
   endpoint sets an interview state and sends the first question to the OWNER's phone
   (`ownerPhone` on the business record) via `sendWhatsAppToCustomer`. The interview is a
   deterministic state machine keyed off the owner's phone in `userStates` (same pattern as
   RESERVATION): asks each unanswered suggested question one at a time; owner's reply is saved
   verbatim as the answer; "skip" skips; "stop" ends and reports how many were saved. The AI
   never invents answers — replies are stored as given. (Guard: interview mode only activates
   for the exact ownerPhone, and only while the state is active — customers are unaffected.)
3. **Prompt injection + guardrail**: knowledge pairs render into the Gemini context as
   `Café facts (answer ONLY from these; if the answer isn't here, escalate):`. Unknown
   questions keep flowing to the existing `unanswerable` escalation — the AI must never guess
   facts about the café.
4. Eval: the FAQ golden cases flip to passing; add interview-flow cases (owner phone) to the set.

**Commit**: `AI3: cafe knowledge base — Teach-your-AI form + WhatsApp owner interview`

### AI4 — Persona, professional tone, personalization

1. **Setting**: `assistantName` in `branch-settings.json` (default `"Asha"`), editable in the
   same "Teach your AI" panel (text field + "leave blank to speak as the café"). Exposed via the
   existing GET/PUT `/businesses/:id/settings` (extras.js) alongside aiMaxDiscount.
2. **Prompt overhaul** in `generateGeminiReply` — the receptionist spec:
   - warm, professional, CONCISE (2–3 sentences unless listing menu items);
   - greet known customers by name; vary phrasing (never open two consecutive replies the same way);
   - emoji discipline (≤2 per reply, natural placement);
   - if named: introduce as `${assistantName}` from the café on FIRST reply of a conversation
     (no history in last 24h), not every message; if blank: speak as "we";
   - honesty rule: if asked, it is the café's AI assistant — never claims to be human;
   - never state a price, timing or fact not present in the provided menu/context/knowledge
     (anti-hallucination guardrail sentence).
3. **Personalization context**: extend the customer block with favourite item (top item from
   their paid orders — add db.js helper `getCustomerTopItem(businessId, phone)`), days since
   last visit, and tier — so replies like "Welcome back Rahul! Your usual Cold Coffee? ☕"
   emerge naturally. Numbers computed in JS, injected as facts.
4. Rewrite the canned deterministic-fallback replies to match the same tone (they currently
   read robotic); language-switched via detectLanguage as today.
5. Eval: persona cases pass; add regulars-greeting cases; re-run FULL suite and record score
   vs AI0 baseline in the commit message.

**Commit**: `AI4: named persona, receptionist tone spec, regular-customer personalization`

### AI5 — Reliability hardening (paid-tier ready)

1. `GEMINI_MODEL` env var (default `gemini-2.5-flash`) — switch models without code changes.
2. Circuit breaker: ≥3 consecutive Gemini failures → skip Gemini for 2 minutes (deterministic
   tier serves; `console.error` once, not per message). Prevents 30s of hammering during outages.
3. Latency + failure logging via `db.logEvent(branchId, 'ai.call', { metadata: { ms, ok, model } })`
   — gives the owner-facing "AI health" data later and us tuning data now.
4. Update `docs\CAFE_WHATSAPP_ONBOARDING.md` with a short "switching to paid Gemini" note
   (billing on the key, raise limits, set GEMINI_MODEL if upgrading model).
5. Full eval with `--no-gemini` (deterministic tier 100%) and with Gemini (report %).

**Commit**: `AI5: model env config, circuit breaker, AI call telemetry`

### AI6 — Regression, deploy, post-deploy smoke

1. Test-data purge (§6); `git status` clean (known stray: `data/data/backups/*` untracked, ignore).
2. Full local regression: complete eval suite (record final score vs AI0 baseline — this is the
   headline number); manual pass of manager dashboard (menu tab incl. AI Max %, Teach-your-AI
   panel, Customer Chats live view, escalations, growth card); `/onboard` flow; chat simulator.
3. Push; give the user the single-line deploy; then post-deploy smoke: `/` 200 · `/api/plans`
   200 · `/hq` 401 · webhook GET 200-echo · user sends a real WhatsApp message and confirms
   memory ("how much is the pasta?" → "make it two") + persona greeting live.
4. Update this guide's Status line, `docs\ZORDIC_MASTER_PLAN.md` if touched, and session memory
   (`project-zordic-california.md`: AI receptionist v2 shipped; eval score before/after).

---

## §6 Testing protocol (every package)

Disposable café: `POST http://localhost:3010/api/onboard` → note businessId + credentials.
Destroy afterwards (server STOPPED first): delete business_id rows across all SQLite tables
(incl. `chat_messages`, `escalations`, `coupons`, `events`), `rm -rf data/<id>`, reset
`data/businesses.json` to `[]`. The eval harness automates create/destroy — reuse its functions
for manual tests where convenient.

## §7 Out of scope — do not start these

- Voice-note transcription; ordering via chat; payment links (future capability packages)
- Model fine-tuning of any kind; per-plan model tiers (deferred by user decision §1.3)
- Embedded Signup / Tech Provider work (see CAFE_WHATSAPP_ONBOARDING.md — separate track)
- Rewriting the reservation/feedback state machines (they work; AI2 only re-orders around them)
- Any change to money paths beyond respecting existing discount ceilings
