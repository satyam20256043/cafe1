# ZORDIC IMPROVEMENTS ROADMAP — v1.0 (for a Haiku execution session)

Six small, sharply-scoped packages that close the revenue leaks and reliability gaps found in
the 2026-07-19 product analysis. Execute **IMP0 → IMP5 in order, committing after each**.
This guide is written for a Haiku session: every package names the exact file, the exact
anchor to edit, and the exact verify commands. **Follow it literally. Where the guide and the
code disagree, STOP and report — do not improvise.**

**Status: EXECUTED — IMP0-IMP5 all complete and committed 2026-07-21** (commits
`da1bac5`, `69fe316`, `40dc430`, `1f6446a`, `2aa18d4`, `5515195`; not yet pushed/deployed —
awaiting user go-ahead, same as the last deploy). Each package verified with a real running
server against a disposable test café, not just read-through: IMP0/IMP1 via direct HTTP
calls; IMP2 via a simulated WhatsApp webhook against dummy Cloud credentials, confirming a
real `wa_send_failed` alert and 6h debounce; IMP3 via an isolated 10-case unit test plus a
real request that hit the (still-dead) local Claude key and confirmed zero wasted retries;
IMP4 via a temporarily-redirected integrity check proving the corrupt-backup path actually
fires; IMP5 via a temporarily-immediate scheduler trigger against a real trial café, proving
both the once-ever send guard and the manager-facing API payload the banner reads from.
`opsAlerts` (IMP2) ended up wired into IMP4's backup-failure paths too, beyond what IMP2's
own package originally scoped.

---

## 0. Context — read fully before touching any file

- Repo: **`C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`** (NOT `C:\Users\SSJ\Desktop\...` — Desktop
  moved under OneDrive). Branch **`master`** only. Work only in `data\` + `public\` + `docs\`.
  Root `server.js` is a frozen legacy monolith — never edit it.
- Production: live at zordic.in (Lightsail, pm2 app name `zordic`). ONE real café is live
  (`the_roasted_bean_mren3zjb`, WhatsApp linked via QR mode). Be careful: every commit here
  ships to a live business on the next deploy.
- Local test server: launch via **Bash**: `node data/server.js` (port 3010). NEVER use the
  preview tool. NEVER start a QR WhatsApp client locally (don't call `/whatsapp/qr/start`).
- Test hygiene (§5) before every commit. `git status` must be clean apart from the known
  untracked `data/data/backups/*.db`.
- **Commit after each package with the exact message given. NEVER push** — the user pushes.

**Verified codebase facts (2026-07-19) — trust these, don't rediscover:**
- AI dispatch: `aiDecisionForBranch(branchId)` in `data/server.js` (~line 78). Returns
  `'claude' | 'claude_capped' | 'silent' | 'gemini'`. Plan is read as
  `business.plan || business.subscriptionPlan` (two historical fields, kept in sync by
  writers — read both, always).
- LLM callers: `callGemini(prompt)` (~line 706) and `callClaude(prompt)` (~line 719) in
  `data/server.js`. Both return the text or `null` on error. `processCafeBotReplyInner` falls back
  to a local keyword tier when they return null. A `null` from `processCafeBotReply` means
  "stay silent" — that behavior is deliberate (Starter over-cap); never change it.
- Daily metering: `db.getClaudeUsageToday(branchId, dateKey)` / `db.bumpClaudeUsage(...)`
  (in `data/db.js`, `ai_daily_usage` table); date key from `aiUsageDateKey()` in server.js.
- Razorpay ctx: `data/server.js` ~line 2026 builds the client from `RAZORPAY_KEY_ID` /
  `RAZORPAY_KEY_SECRET` env. **Production `.env` still has placeholder keys** that look like
  `rzp_test_ENTER_YOUR_KEY_ID_HERE` — a client object gets constructed, so `razorpay` is
  truthy, and payment endpoints crash with a raw 500 at call time.
- Scheduler pattern to copy: `data/backup.js` `scheduleDaily()` (~line 103) — computes
  ms-until-target-hour, `setTimeout`, then `setInterval(fn, 24h)`.
- Outbound WhatsApp: `sendWhatsAppToCustomer(branchId, phone, text)` in server.js — works for
  Cloud AND QR cafés, returns false when the café has no working WhatsApp. Owner's number is
  `business.ownerPhone` on the businesses record.
- Realtime: `emitToBranch(branchId, event, payload)` ONLY. Never bare `io.emit`.
- HQ admin auth: `requireAuth, requireRole('agency_admin')`. Per-café staff endpoints:
  `requireAuth, requireBranchAccess`.
- manager.html has a global fetch interceptor injecting the auth header (~line 1453) — new UI
  code uses plain `fetch`. hq.html inlines `{'Authorization':'Bearer '+localStorage.getItem('cafehq_token')}`.
- `data/agency-settings.json` keys: `baseUrl, whatsapp, gemini, vapid, updatedAt, updatedBy`
  (no operator-phone field — IMP2 uses an env var instead).

## 1. Locked decisions (2026-07-19 — do not re-ask, do not soften)

1. **Trial cafés get capped Claude** (IMP0): same treatment as Starter — Haiku up to
   `STARTER_CLAUDE_DAILY_LIMIT`/day, then silent. Rationale: trials were landing on the dead
   Gemini key and evaluating the product on dumb keyword replies. Trials must taste the real AI.
2. **Placeholder Razorpay = "payments not enabled" response, not a crash** (IMP1). Manual
   payment stays the norm; the self-serve path must fail gracefully with a clear message.
3. **Operator alerts are pull + badge, v1** (IMP2): alerts persist to a JSON file, HQ shows a
   red badge + list, and IF `OPERATOR_ALERT_PHONE` env is set AND the alerting café has working
   WhatsApp, a WhatsApp ping is attempted best-effort. No email, no external services.
4. **Retry/backoff + circuit breaker** (IMP3) wrap BOTH LLM callers. Retries only on
   transient errors (429/5xx/network) — NEVER retry a 401/403 (bad key ≠ transient).
5. **Backup integrity + failure alerts** (IMP4) — code verifies each backup opens as SQLite;
   offsite protection is a USER console task (§6), not code.
6. **Trial lifecycle nudges** (IMP5): dashboard countdown banner always; WhatsApp reminder to
   the owner at 5 days and 1 day remaining, best-effort, max once per day per café.

## 2. Hard rules for the executor (Haiku)

- DO NOT touch: `data/waweb.js`, `data/routes/wa-qr.js`, `data/routes/orders.js` money paths,
  `buildReceptionistPrompt`, the escalation engine, or anything in `public/` except the exact
  spots named below.
- DO NOT add npm dependencies. DO NOT print or edit `.env` values.
- If an anchor string given below does not match the file exactly: **STOP, report the
  mismatch, do not guess.**
- If a verify step fails twice after honest attempts: **STOP and report** with the output.
- Never delete or rewrite passing behavior to make a test simpler.

## 3. Work packages

### IMP0 — Trials get capped Claude (the conversion-leak fix)
**File:** `data/server.js`, function `aiDecisionForBranch`.
Current logic (verbatim anchor):
```js
  if (anthropic && PREMIUM_AI_PLANS.includes(plan)) return 'claude';
  if (anthropic && plan === 'starter') {
```
Change so that **starter AND plan-less/trial cafés** share the capped path:
```js
  if (anthropic && PREMIUM_AI_PLANS.includes(plan)) return 'claude';
  // Starter AND trial/no-plan cafés: capped Claude. Trials must experience the
  // real AI during evaluation (the old Gemini fallback had a dead key and gave
  // trials keyword-tier replies for their entire decision window).
  if (anthropic && (plan === 'starter' || !plan)) {
```
(only the condition and comment change; the capped body stays identical).
Also update the doc-comment block above the function and the one above `generateAIReply` so
they say: growth/pro unlimited; starter + trial capped; gemini only when no Anthropic key.
**Verify (Bash):** temp `businesses.json` (backup first, server STOPPED) with a no-plan trial
café; boot with `ANTHROPIC_API_KEY=sk-ant-dummy STARTER_CLAUDE_DAILY_LIMIT=3`; preload
`ai_daily_usage` to 3 for it (pattern: `db.bumpClaudeUsage(id, key)` ×3 with today's local
date key `YYYY-MM-DD`); POST `/api/businesses/<id>/chat` `{"phone":"919111000111","text":"hi"}`
→ expect `{"success":true,"reply":null}` (capped path reached = trial now on Claude metering).
Reset counter to 0, send again → reply is a STRING (dummy key fails → local tier fallback —
that proves the under-cap path also flows). Restore businesses.json, purge test rows
(`ai_daily_usage`, `events`, `chat_messages` for the test id).
**Commit:** `IMP0: trial cafes get capped Claude instead of dead-key Gemini`

### IMP1 — Razorpay placeholder = graceful "payments not enabled"
**File:** `data/server.js` ~line 2026 (the `razorpay:` line in routeCtx). Replace the IIFE so
placeholder/missing keys yield `null`:
```js
  waApi, genAI, razorpay: (() => { try {
    const kid = process.env.RAZORPAY_KEY_ID || '';
    if (!kid || kid.includes('ENTER_YOUR')) return null; // placeholder → payments disabled
    return new (require('razorpay'))({ key_id: kid, key_secret: process.env.RAZORPAY_KEY_SECRET });
  } catch(e){ return null; } })(),
```
**File:** `data/routes/billing.js` — find every handler that uses `razorpay` (grep
`razorpay.` in that file). At the top of each such handler add (match existing style):
```js
  if (!razorpay) return res.status(503).json({ error: 'Online payment is not enabled yet — please contact us to activate your plan.' });
```
(only where a null `razorpay` would otherwise be dereferenced; read each handler first).
**Verify:** boot locally WITHOUT Razorpay env vars → server boots clean; hit the
create-order/checkout endpoint (find its path in billing.js) with a valid staff token →
expect the friendly 503 JSON, NOT a stack trace. `node -c data/routes/billing.js` passes.
**Commit:** `IMP1: placeholder Razorpay keys fail gracefully instead of 500`

### IMP2 — Operator alerting (the "silent outage" fix)
New module **`data/ops-alerts.js`**:
- `raiseAlert(kind, branchId, message)` → appends `{ id, kind, branchId, message, at }` to
  `data/ops_alerts.json` (create if missing; cap file at newest 200 entries), console-logs
  `[OPS ALERT] ...`, and — best-effort, wrapped in try/catch — if `process.env.OPERATOR_ALERT_PHONE`
  is set, calls the `sendWhatsAppToCustomer` passed in via an `init({ sendWhatsAppToCustomer })`
  hook, using the ALERTING branch's own WhatsApp (it's the only sender that exists).
- **Debounce:** same `kind+branchId` at most once per 6h (keep an in-memory map).
- `listAlerts()` → newest-first array. `clearAlerts()` → empties the file.
Wire-up in **`data/server.js`**:
- `const opsAlerts = require('./ops-alerts'); opsAlerts.init({ sendWhatsAppToCustomer });`
  after `sendWhatsAppToCustomer` is defined.
- Raise alerts at these EXISTING failure points (add one line each, do not restructure):
  1. `sendWhatsAppToCustomer` Cloud catch block → `opsAlerts.raiseAlert('wa_send_failed', branchId, e.message)`
  2. `callClaude` catch → on message containing `401` → `raiseAlert('claude_auth', 'global', ...)`
  3. `callGemini` catch → on message containing `401` → `raiseAlert('gemini_auth', 'global', ...)`
  4. QR `onDisconnected` in `startQrClientForBranch` → `raiseAlert('wa_qr_disconnected', branchId, reason)`
- Endpoints (admin-only, `requireAuth, requireRole('agency_admin')`, add in
  `data/routes/agency.js` following its existing style): `GET /api/agency/ops-alerts` →
  `{ alerts: listAlerts() }`; `POST /api/agency/ops-alerts/clear` → `{ success:true }`.
**File:** `public/hq.html` — in the HQ header (next to the existing tab row), add a small
`<span id="ops-alert-badge" style="display:none">🔔 <b id="ops-alert-count">0</b></span>` that
polls `GET /api/agency/ops-alerts` every 60s; if alerts exist, show the badge red
(`background:var(--rose-lt);color:var(--rose);border-radius:12px;padding:2px 10px;cursor:pointer`)
and `onclick` shows `alert()` with the newest 5 messages + a confirm to clear. Keep it that
simple — no new tab, no new pane.
**Verify:** boot locally; force a failure (call the chat endpoint for a café whose
whatsapp_config.json has dummy cloud creds → send fails) → `data/ops_alerts.json` gains an
entry; GET endpoint returns it (agency token); second identical failure within minutes does
NOT double-log (debounce); clear endpoint empties it; hq badge appears via puppeteer or curl
check of the endpoint only (UI check optional). Purge `data/ops_alerts.json` before commit.
**Commit:** `IMP2: operator ops-alerts — send/auth/QR-disconnect detection + HQ badge`

### IMP3 — LLM retry/backoff + circuit breaker
**File:** `data/server.js`. Add ONE shared helper above `callGemini`:
```js
// Retry transient LLM failures (429/5xx/network) with short backoff; never
// retry auth errors. A per-provider circuit breaker stops hammering a
// provider that is hard-down: 5 consecutive failures → open for 60s.
const _llmBreaker = { claude: { fails: 0, openUntil: 0 }, gemini: { fails: 0, openUntil: 0 } };
function _isTransientLlmError(e) {
  const m = String(e && e.message || e);
  if (m.includes('401') || m.includes('403') || m.toLowerCase().includes('invalid')) return false;
  return m.includes('429') || m.includes('500') || m.includes('502') || m.includes('503')
      || m.includes('529') || m.toLowerCase().includes('fetch') || m.toLowerCase().includes('network') || m.toLowerCase().includes('timeout');
}
async function withLlmRetry(provider, fn) {
  const br = _llmBreaker[provider];
  if (Date.now() < br.openUntil) return null; // circuit open — skip straight to fallback
  const delays = [0, 400, 1200];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const out = await fn();
      br.fails = 0;
      return out;
    } catch (e) {
      if (!_isTransientLlmError(e)) { br.fails = 0; throw e; } // real error → caller's catch
      if (++br.fails >= 5) { br.openUntil = Date.now() + 60000; console.warn(`[LLM] ${provider} circuit OPEN 60s`); }
      if (i === delays.length - 1) throw e;
    }
  }
  return null;
}
```
Then wrap the BODIES of `callClaude` and `callGemini`: keep each function's signature and
outer try/catch exactly as-is; inside the try, wrap the actual API call in
`await withLlmRetry('claude', async () => { ...existing call+extract, return textOut... })`
(same for `'gemini'`). The outer catch still returns null, so pipeline behavior is unchanged.
**Verify:** `node -c data/server.js`; boot clean; chat round-trip on a test café still
returns a reply (local tier is fine); unit-check the helper directly:
`node -e` script requiring nothing — copy the helper into a scratch file and assert: transient
error retries 3 times then throws; 401 error throws immediately without retry; 5 failures
opens the breaker (next call returns null instantly). Keep the scratch file in the session
scratchpad, not the repo.
**Commit:** `IMP3: LLM retry/backoff + per-provider circuit breaker (AI5 reliability)`

### IMP4 — Backup integrity check + failure alert
**File:** `data/backup.js`, inside `runBackup`'s success path — it uses better-sqlite3's
online backup API: `raw.backup(destPath)` returns a promise; add this inside its `.then`
block (the one that logs `✓ Backup saved`), and `destPath` is the actual variable name:
```js
    // Integrity: a backup that can't be opened as SQLite is not a backup.
    try {
      const check = new (require('better-sqlite3'))(destPath, { readonly: true });
      check.prepare('SELECT count(*) c FROM sqlite_master').get();
      check.close();
    } catch (e) {
      console.error('[BACKUP] ✗ integrity check FAILED:', e.message);
      try { require('./ops-alerts').raiseAlert('backup_corrupt', 'global', e.message); } catch (_) {}
    }
```
(Adapt `destPath` to the actual variable name in `runBackup` — read the function first.)
Also wrap the whole `runBackup` body's existing failure path (if none, add try/catch) so a
throw raises `raiseAlert('backup_failed', 'global', e.message)` instead of dying silently.
**Verify:** run `node -e "require('./data/backup.js').runBackup()"` from the repo root →
backup file created, no alert raised; then temporarily point the check at a text file to see
the corrupt path raise an alert (revert the temp change); `data/ops_alerts.json` purged after.
**Commit:** `IMP4: backup integrity verification + ops-alert on backup failure`

### IMP5 — Trial lifecycle: countdown banner + expiry reminders
1. **Scheduler** in `data/server.js` `server.listen` callback (copy the
   `scheduleWeeklyGrowthSuggestions` IIFE pattern, daily at ~09:30 local):
   for each business where `subscriptionStatus === 'trial'` and `trialEndsAt` exists, compute
   `daysLeft = Math.ceil((new Date(trialEndsAt) - Date.now())/86400000)`; if `daysLeft === 5`
   or `daysLeft === 1`, and the café has an `ownerPhone`, send via `sendWhatsAppToCustomer`:
   `⏳ Your Zordic free trial ends in ${daysLeft} day(s)! Keep your AI receptionist working — reply here or visit your dashboard to pick a plan. ☕`
   Track sends in `data/<branchId>/trial_notices.json` (`{ sent: { "5": iso, "1": iso } }`)
   so each notice goes at most once ever per café.
2. **Manager banner** in `public/manager.html`: the page already loads `business` — after load
   (find where `business` is set and the existing notification banner patterns near the top of
   `<body>`), if `business.subscriptionStatus === 'trial'` and `business.trialEndsAt`, inject a
   slim banner at the top: `⏳ Free trial — X day(s) left. Contact us to activate your plan.`
   with `background:var(--cream)` styling matching existing banners; red-tinted when ≤5 days.
   (The public business payload already includes what manager.html uses; if `trialEndsAt` is
   missing from the staff-facing business object, read it from the `/api/businesses/:id/subscription`
   status endpoint that already exists — check `data/routes/business.js` ~line 296-330 for the
   fields the manager actually receives, and use whichever source already carries it.)
**Verify:** temp trial café with `trialEndsAt` 5 days out; run the scheduler function directly
via a small exported hook or by temporarily invoking its inner function in a `node -e` harness
(acceptable: extract the per-business check into `function runTrialReminders()` and export it
on `module.exports`-adjacent routeCtx so it's callable; scheduler calls it daily) →
`trial_notices.json` written once, second run sends nothing; manager banner renders (puppeteer,
temp staff login, screenshot); expiry path untouched. Full §5 cleanup.
**Commit:** `IMP5: trial countdown banner + 5-day/1-day WhatsApp reminders`

## 4. NOT for this session — do not attempt (escalate to a Sonnet/Opus session)

- **AI1 conversation memory**, **AI2 LLM-first router**, **AI4 persona** — core-prompt surgery,
  covered by `docs/ZORDIC_AI_RECEPTIONIST_GUIDE.md` (note: its AI5 package is satisfied by
  IMP3 — update that guide's status line when IMP3 lands).
- **WhatsApp order-taking** (AI completes orders end-to-end) — needs its own guide.
- **Daily Growth Brief / Weekly Impact Report** — `docs/ZORDIC_MASTER_PLAN.md` Phase 1 /
  the plan file's WP4-WP5; big build, separate session.
- Anything touching money paths, tenant isolation, or the QR client lifecycle.

## 5. Testing protocol (same as every prior guide)

- Bash server on 3010. Temp staff via `db.createStaff` + bcryptjs; delete after.
- `businesses.json` edits ONLY with the server stopped; always `cp` a `.bak` first and
  `mv` it back after.
- Purge test rows from `events`, `chat_messages`, `ai_daily_usage` for every test café id;
  `rm -rf data/<test_id>`; delete `data/ops_alerts.json` test content.
- Never touch `the_roasted_bean_mren3zjb`'s data or `.wwebjs_auth/`.

## 6. User-side ops (NOT for the agent — surface these in the final summary)

1. Replace production `GEMINI_API_KEY` with a real `AIza…` key (aistudio.google.com/apikey) —
   current value is an `AQ.`-prefixed OAuth token. Verify with the GEMINI OK/BAD one-liner.
2. Lightsail RAM upgrade to 2 GB (snapshot → new instance → move static IP) — QR sends are
   slow until then.
3. Enable Lightsail **automatic snapshots** (console → instance → Snapshots → automatic) —
   this is the offsite-backup story that code can't provide.
4. Real Razorpay keys whenever self-serve payments should go live (IMP1 makes the absence
   graceful, not functional).
5. Set `OPERATOR_ALERT_PHONE` in production `.env` (your own WhatsApp number, digits only)
   so IMP2 alerts can ping you.
