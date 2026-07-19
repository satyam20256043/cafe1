# ZORDIC WHATSAPP QR-LOGIN GUIDE — v1.0 (for an Opus execution session)

Add a **"Quick connect — scan a QR code"** WhatsApp option so a café owner links their
WhatsApp number by scanning a code from their phone (exactly like WhatsApp Web) — zero Meta
developer setup. Execute packages **QR0 → QR4 in order, committing after each**. Read §0–§2
fully before touching any file. Decisions in §1 were locked by the user on 2026-07-18 — do
**not** re-ask them.

**Status: NOT YET EXECUTED** (written 2026-07-18).

---

## 0. Context — read first

- **Zordic California** is a multi-tenant café SaaS live at `https://zordic.in`
  (repo `github.com/satyam20256043/cafe1`, branch **`master`** ONLY — GitHub's default `main`
  is an unrelated scaffold). Local repo: **`C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`**.
  Work only in `data\` + `public\`. Root `server.js` is a frozen legacy monolith.
- **Why this feature**: Cloud API onboarding is the #1 friction point — each café needs a Meta
  developer app, `phoneNumberId`, `accessToken`, webhook subscription (see
  `docs/`/memory: the WABA-subscribed-apps trap), and non-permanent tokens expire (a live
  café's outbound died this way). QR login removes ALL of that for a trial/small café.
- **Deploy line** (Lightsail browser SSH corrupts multi-line pastes — always single line):
  `cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`

**Verified codebase facts (2026-07-18) — build on these, do not rediscover:**

- `whatsapp-web.js` is **NOT a dependency** (removed long ago). `data/server.js:21` has
  null legacy stubs: `let Client = null, LocalAuth = null, qrcode = null, whatsappClient = null;`.
  The `qrcode` npm package IS installed (used for table QRs) — reuse it for QR data-URLs.
- **The old QR mode was SINGLE-tenant** — one global `whatsappClient` plus
  `activeRealBotBusinessId = 'indiranagar'` hardcoded at `data/server.js:330`. Dormant
  null-checked remnants still reference it:
  - `data/server.js` ~1249 (manager alert), ~1918 (autopilot send), ~2619 (`whatsapp_state`
    socket emit), ~2695 (campaign send)
  - `data/routes/loyalty.js` ~160, ~192 (birthday sends)
  - `data/routes/business.js` ~266 (welcome message)
  - `data/routes/marketing.js` ~940-975 (legacy inbound `msg.reply` handler)
  These are DEAD code today (guarded by `whatsappClient` being null). QR4 removes/replaces
  them — do NOT resurrect the single-tenant pattern.
- **The live path is Cloud API**: `getWaConfig(branchId)` reads
  `data/<branchId>/whatsapp_config.json` (`{phoneNumberId, accessToken}`);
  `sendWhatsAppToCustomer(branchId, phone, text)` (server.js ~2017) sends via `waApi` and
  returns false when unconfigured; inbound arrives at `POST /api/webhook/whatsapp`
  (server.js ~2140+) → `processCafeBotReply(branchId, fromPhone, text, {channel:'whatsapp'})`.
  **`processCafeBotReply` can return `null`** (Starter café over its daily Claude cap →
  deliberate silence) — every new send site MUST guard `if (reply)` like the webhook does.
- ALL owner-facing WhatsApp features route through `sendWhatsAppToCustomer`: escalations,
  password-reset OTP, growth suggestions, AI3 "Teach your AI" interview. Fix the dispatcher
  once (QR2) and they all work on QR mode automatically.
- Realtime: ALWAYS `emitToBranch(branchId, event, payload)` — never bare `io.emit`
  (tenant-isolation rule from Phase 0). Manager dashboard sockets already join their branch
  room.
- Route modules get `routeCtx` (server.js ~1985): new shared functions must be added there AND
  destructured in the module. `ctx.db` is the whole db.js exports object, not a sqlite handle.
- manager.html Settings already has the "WhatsApp Cloud API" panel (~line 1248,
  `saveWhatsAppConfig`/`testWhatsAppConfig`, status dot `wa-dot-2`) and a global fetch
  interceptor that injects the auth header (~line 1453) — plain `fetch` works in new UI code.
- Local dev server must be launched via **Bash** (`node data/server.js`, port 3010), never the
  preview tool (sandbox blocks outbound network).

## ⚠️ Two hard operational constraints (read twice)

1. **RAM**: each whatsapp-web.js client runs a headless Chromium (~150–300 MB). Production is
   a 414 MB Lightsail instance with a 2 GB swapfile. **One or two QR cafés max** before the
   instance must be upgraded (≥2 GB RAM). QR0 adds lean launch flags; QR3 adds a hard cap
   (`WA_QR_MAX_CLIENTS`, default 2) with a clear error when full. Tell the user to upgrade the
   instance before onboarding QR café #3.
2. **ToS / ban risk**: whatsapp-web.js is an UNOFFICIAL client; WhatsApp can ban numbers, and
   bulk/marketing sends are the classic trigger. That's why §1 locks QR mode to
   conversational receptionist traffic only. Never weaken this without the user's explicit
   say-so. Surface the risk once in the connect UI ("unofficial linking — for trials and
   small cafés; Cloud API recommended for scale") — honest, not scary.

## 1. Locked decisions (2026-07-18 — do not re-ask)

1. **QR mode coexists with Cloud API, per café.** `whatsapp_config.json` gains
   `mode: 'cloud' | 'qr'` (absent → `'cloud'` for back-compat). A café uses one mode at a
   time; connecting one disconnects/replaces the other (with a confirm in the UI).
2. **Multi-tenant by design**: one whatsapp-web.js `Client` per QR café, sessions persisted
   with `LocalAuth({ clientId: branchId })` so a pm2 restart re-links WITHOUT rescanning.
   Session dirs (`.wwebjs_auth/`, `.wwebjs_cache/`) are gitignored.
3. **QR mode = conversational receptionist only.** Inbound customer chats + AI replies +
   owner alerts/escalations/OTP/AI3-interview all work. **Bulk campaign sends (autopilot,
   birthday blasts, win-back blasts, growth-suggestion approved campaigns) stay
   Cloud-API-only** — on a QR café they are skipped with a logged `[WA QR] bulk send skipped`
   line and a dashboard note, protecting the owner's number from bans. (Env override
   `WA_QR_ALLOW_BULK=1` exists but is undocumented in UI.)
4. **UI lives in the existing manager Settings WhatsApp panel** as two clearly-labelled
   options: "⚡ Quick connect (scan QR)" and "🏢 Business API (Meta)" — Cloud API stays the
   recommended badge. QR flow shows the live QR in the panel, then the connected number +
   Disconnect button.
5. **Cloud API remains the recommended production path**; QR is the zero-friction on-ramp.
   Nothing about the existing Cloud flow may regress.

## 2. Ground rules

- Money/DB paths untouched. AI discipline unchanged. No new socket patterns — `emitToBranch`
  only. Auth: connect/disconnect/status endpoints are `requireAuth, requireBranchAccess`.
- Never log or commit session credentials; `.wwebjs_auth/` holds live WhatsApp session keys —
  treat like `.env`.
- Every outbound QR send goes through ONE dispatcher (`sendWhatsAppToCustomer`) — no route
  module may hold a client reference directly. Kill the old `ctx.whatsappClient` getter usage.
- Test-data hygiene per §4 before each commit; `git status` clean apart from the known
  untracked `data/data/backups/*.db`.

## 3. Work packages

### QR0 — Dependency, client manager module, boot restore
1. `npm install whatsapp-web.js` (pin exact version in package.json; it bundles puppeteer —
   note the ~300 MB Chromium download; on the Ubuntu server Chromium needs system libs:
   `sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2` — put this in the QR4 deploy notes).
2. Add `.wwebjs_auth/` and `.wwebjs_cache/` to `.gitignore`.
3. New module `data/waweb.js` — the per-branch client manager. Exports:
   - `startClient(branchId, { onQr, onReady, onDisconnected, onMessage })` — creates
     `new Client({ authStrategy: new LocalAuth({ clientId: branchId }), puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run'] } })`,
     wires events, `initialize()`s. Idempotent: a second call for an already-live branch
     returns the existing client.
   - `stopClient(branchId, { logout })` — `logout()` (unlink, wipes session) vs `destroy()`
     (keep session for restart). Always remove from the map.
   - `getStatus(branchId)` → `{ state: 'disconnected'|'qr_pending'|'connecting'|'connected', number, qrDataUrl }`.
   - `activeCount()`, and a module-level cap check against `WA_QR_MAX_CLIENTS` (default 2).
   - Message filter INSIDE the module: ignore `msg.fromMe`, group chats (`@g.us`),
     status/broadcast, non-text-less media (pass caption text if present, else skip).
4. Boot restore in `server.js` `server.listen` callback: for every business whose
   `whatsapp_config.json` has `mode:'qr'`, `startClient` (staggered 5 s apart, respect the
   cap) — LocalAuth restores the session with no QR.
5. Graceful shutdown: on `SIGINT`/`SIGTERM`, `destroy()` all clients before exit (pm2 restart
   safety).
**Verify:** server boots clean with zero QR cafés (no Chromium spawned); `startClient` for a
test branch reaches `qr_pending` and emits a QR string within ~30 s locally; `stopClient`
kills the Chromium process (check Task Manager / `ps`).
**Commit:** `QR0: whatsapp-web.js per-branch client manager + boot restore`

### QR1 — Connect/disconnect API + Settings UI
1. Endpoints (all `requireAuth, requireBranchAccess`, in `data/routes/extras.js` or a new
   `data/routes/waweb.js` route module registered in server.js):
   - `POST /api/businesses/:id/whatsapp/qr/start` — cap check (503 "server is at its QR
     connection limit" when full); starts the client; `onQr` → render with the existing
     `qrcode` npm package to a data-URL, cache it, `emitToBranch(id,'wa_qr',{dataUrl})`;
     `onReady` → write `whatsapp_config.json` `{ mode:'qr', number, linkedAt }` (preserve
     any old cloud fields under `cloudBackup` so switching back is one click), emit
     `wa_status`; `onDisconnected` → update config state, emit `wa_status`, log.
   - `GET /api/businesses/:id/whatsapp/qr/status` — polling fallback for the UI (returns
     `getStatus` + qrDataUrl while pending).
   - `POST /api/businesses/:id/whatsapp/qr/disconnect` — `stopClient(id,{logout:true})`,
     restore `cloudBackup` fields if present else write `{}`, emit `wa_status`.
2. manager.html Settings — restructure the WhatsApp panel into the two §1.4 options.
   QR card: "Connect" button → POST start → show spinner → render `wa_qr` socket event (plus
   3 s polling fallback) as an `<img>` → on `wa_status: connected` show "✅ Linked to +91…"
   + Disconnect button + the §0 honesty line. Confirm dialog when switching modes.
   Reuse the existing status-dot pattern; keep `saveWhatsAppConfig` untouched for cloud.
**Verify (needs the USER's phone — pause and ask):** start → QR renders in Settings →
user scans with a real WhatsApp → status flips to connected, config file written with
`mode:'qr'` and the number; restart the server → auto-relinks without QR; disconnect →
unlinked on the phone too, config restored. Also verify a cloud-mode café's panel is
unchanged.
**Commit:** `QR1: WhatsApp QR connect flow — API + manager Settings UI`

### QR2 — Message pipeline (inbound + outbound dispatch)
1. Inbound (`onMessage` in waweb.js → callback registered by server.js): mirror the Cloud
   webhook handler EXACTLY — `processCafeBotReply(branchId, fromPhone, text, {channel:'whatsapp'})`,
   `emitToBranch` the customer bubble, **guard `if (reply)`** (Starter-cap silence!), send the
   reply via the same client (`msg.reply` or `client.sendMessage`), emit the AI bubble,
   `sendSeen` for read receipts. fromPhone = `msg.from` stripped of `@c.us`.
2. Outbound dispatcher — rework `sendWhatsAppToCustomer(branchId, phone, text)`:
   `mode==='qr'` → `waweb` client (`<phone10>@c.us`, prefix `91` when 10 digits — match the
   existing normalize convention), return false + warn when the client isn't connected;
   else existing Cloud path unchanged. This single change lights up escalations, OTP,
   growth alerts, and the AI3 interview on QR cafés — verify at least OTP + AI3 interview
   end-to-end in testing.
3. Rate-limit QR outbound: simple per-branch queue, min 1.5–2 s between sends (ban
   hygiene; bulk is already blocked by QR3 anyway).
**Verify (user's phone again):** message the linked number from a second phone → AI replies
on WhatsApp; chat appears live in the manager dashboard Conversations tab and in
`chat_messages`; Starter-cap silence test (preload `ai_daily_usage` to the cap on a
starter-plan test café → inbound gets NO reply, no crash); AI3 "Train over WhatsApp" works
on a QR café.
**Commit:** `QR2: QR-mode message pipeline — inbound to AI engine, unified outbound dispatch`

### QR3 — Safety rails
1. Bulk-send paths (server.js autopilot ~1918/2695, loyalty.js birthday ~160, marketing.js
   campaign approve, growth-suggestion approved sends) check mode: QR café → skip + log +
   one-line dashboard notice ("Campaign sends need the Business API — quick-connect numbers
   only handle customer conversations"), unless `WA_QR_ALLOW_BULK=1`.
2. Disconnect resilience: `onDisconnected` → dashboard alert (existing alert/notification
   pattern) + `[WA QR]` log; next boot tries LocalAuth restore once, then marks
   disconnected (no QR spam loops).
3. Cap enforcement surfaced in HQ: Branches/Billing card shows a small "QR-linked" badge per
   café so the operator can see who's on which mode (read from whatsapp_config via an
   existing admin endpoint — smallest change that works).
**Verify:** autopilot dry-run on a QR café logs the skip and sends nothing; kill Chromium
manually → dashboard alert fires; third `qr/start` when cap=2 returns the friendly 503.
**Commit:** `QR3: QR-mode safety rails — bulk-send lockout, disconnect alerts, client cap`

### QR4 — Legacy cleanup, regression, deploy
1. Delete the dead single-tenant remnants (§0 list): `activeRealBotBusinessId`, global
   `whatsappClient` branches in server.js/loyalty.js/business.js, the `whatsapp_state`
   socket emit (replace with per-branch `wa_status` if the dashboard still listens), the
   marketing.js legacy `msg.reply` inbound handler, and the `ctx.whatsappClient` getter.
   Grep `whatsappClient\|activeRealBot` afterwards — must be zero hits outside waweb.js.
2. Full regression: Cloud-mode café message round-trip untouched (webhook path), simulator,
   all manager tabs, all 8 HQ tabs, `node -c` on every touched file, boot with 0 QR cafés
   spawns no Chromium.
3. Test-data purge per §4. Commit, push, then give the user:
   (a) the apt lib one-liner (QR0), (b) `free -m` check + the instance-upgrade recommendation
   before QR café #3, (c) the standard deploy line, (d) note that the first QR connect on the
   server downloads nothing extra (Chromium ships in the npm install — expect a slow
   `npm install` on the 414 MB box; if it OOMs, `npm install --no-optional` won't help —
   swap covers it, just let it run).
4. Update this guide's Status line + session memory (`project-zordic-california.md`).
**Commit:** `QR4: retire single-tenant WA remnants, regression, deploy notes`

## 4. Testing protocol

- Bash-launched server on 3010. Temp staff accounts (`bcryptjs` hash, `db.createStaff`),
  deleted after; never print real credentials. Test cafés get purged: restore
  `businesses.json` from a `.bak` taken BEFORE edits (server STOPPED when editing it), purge
  `events/chat_messages/ai_daily_usage` rows for test ids, `rm -rf data/<testId>` and the
  test branch's `.wwebjs_auth/session-<id>` dir.
- The QR scan itself needs the USER's real phone — pause at those verify steps and ask them
  to scan; everything else is automatable (curl + puppeteer for UI, as in prior packages).
- Watch RAM locally too: `tasklist | findstr chrome` / Task Manager — one client should stay
  under ~350 MB.

## 5. Out of scope — do not build

- Multi-device/multi-number per café; group-chat handling; media/voice message replies
  (text-only; media inbound → polite "please type your question" fallback is fine).
- Migrating existing Cloud cafés to QR automatically.
- Any change to the AI pipeline, plans/billing, or the Leads/knowledge features.
- Puppeteer-cluster / external browser pools — one lean Chromium per café with the cap is
  the whole design at this scale.
