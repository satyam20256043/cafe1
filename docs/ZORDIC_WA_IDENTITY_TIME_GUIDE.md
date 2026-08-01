# WhatsApp Identity (LID) + Timezone — Full Fix Guide

**For: a Claude Sonnet session with no prior context. Written 2026-08-01 by a
Fable session that lived through the incident below and verified every fact in
this file against the actual code and production data. Trust this file over
commit messages (one commit message is explicitly wrong — see §1.9).**

Repo: `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`, branch `master`, GitHub
`satyam20256043/cafe1`. Two production servers, deployed by the USER pasting
single-line SSH commands (you have no server access — always hand the user one
`&&`-chained line and read their pasted output):

| | zordic.in (`~/zordic`, pm2 `zordic`) | zordical.com (`~/zordical`, pm2 `zordical`) |
|---|---|---|
| Tenants | **5 REAL businesses** — treat data as production | test cafés only (disposable, but per standing instruction: never delete them) |
| RAM | **414MB** — Chromium barely fits, sessions corrupt under restart pressure | 4GB — comfortable |
| WA QR café | `the_roasted_bean_mren3zjb` (whatsapp-web.js, session recently reset, may need a fresh QR scan) | `roasted_bean_ms7jj29g` (**broken**: Chromium missing `libcairo.so.2`) |

Deploy loop: `cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`
(swap `zordic`→`zordical` for the other box). `--update-env` is mandatory after `.env` changes.

---

## §0 — The two problems, in plain terms

**Problem A — WhatsApp privacy IDs corrupted customer identity.** WhatsApp now
addresses some senders on QR-linked (whatsapp-web.js) connections by a privacy
LID — `<13-15 digits>@lid` — instead of `<phone>@c.us`. The LID digits are NOT
a phone number. The QR inbound handler stripped `@lid` and treated the digits
as the customer's phone. Consequences, all observed live on zordic.in:

1. Manager portal shows garbage "phone numbers" (`220276088422403`,
   `2045540603`, …) for real customers.
2. Every feature that *initiates* a send later (re-engagement nudges, campaigns,
   trial reminders, OTP, offers) reads that stored value, and the send layer
   fails with **`No LID for user`** — because you can't build a WhatsApp id
   from LID digits. This is why "the bot doesn't reply after the time gap":
   the 10-min/25-min re-engagement sweep found the quiet threads and built the
   messages, but every send failed, forever, silently retrying each 60s tick.
3. One human is stored under TWO different keys (see §1.3) — profile, chat
   history, and loyalty for the same person are fragmented.

Live conversation replies always kept working — the reply path uses the
original full id from the inbound message, not the stored digits. That's why
the bug stayed invisible until the re-engagement feature shipped.

**Problem B — timestamps shown to staff are 5.5h off.** Both production boxes
run UTC. Two distinct mechanisms (only one is fixed):
- Server-side `new Date().toLocaleString()` renderings (profile `lastActive`,
  socket payload timestamps) — **fixed** by `process.env.TZ` defaulting to
  `Asia/Kolkata` at boot (commit `290dd8e`).
- Client-side parsing of SQLite `CURRENT_TIMESTAMP` strings — **NOT fixed**.
  SQLite always writes UTC (`2026-08-01 10:31:05`, no zone marker), the API
  returns it raw, and the browser's `new Date("2026-08-01 10:31:05")` parses
  it as LOCAL time — so an IST browser displays the UTC digits as if they were
  IST. Chat-history times, orders times, anything rendered from `created_at`
  is wrong by 5.5h. See §5.

---

## §1 — Verified facts (each checked against code/data on 2026-08-01; anchors may drift a few lines)

1. **`db.normalizePhone`** (data/db.js:22-24) = strip non-digits, **keep last
   10**. A 15-digit LID `220276088422403` → `6088422403`.
2. **`updateCustomerProfile`** (data/server.js:492-529) keys
   `customer_profiles.json` by the **RAW** phone string (`p.phone === phone`),
   and every call site passes the un-normalized value. SQLite paths
   (chat_messages / loyalty / reengagement_state) end up keyed by the
   **normalized last-10** form.
3. **Therefore one LID sender exists under two keys**: profiles hold
   `220276088422403`, SQLite holds `6088422403`. The production data confirms
   this pairwise (`118795238649998`↔`5238649998`, `148142045540603`↔`2045540603`,
   `103152481222894`↔`2481222894`, `205230817939552`↔`0817939552`). This
   fragmentation predates all recent fixes.
4. **Real Indian mobile shape**: `[6-9]` + 9 digits (10 total), optionally
   prefixed `91`. Anything ≥13 digits is a LID. **A last-10 LID truncation
   starting 6-9 is indistinguishable from a real phone by shape alone**
   (`6088422403`, `7929813363` could be either). `9999999999` is a legitimate
   web-chat-simulator test number — don't classify it as garbage.
5. **The proper resolution API exists in the installed whatsapp-web.js**:
   `client.getContactLidAndPhone(userIds)` → `[{ lid, pn }]`
   (node_modules/whatsapp-web.js/src/Client.js:3307). It calls WhatsApp Web's
   own `WAWebApiContact.getPhoneNumber(wid)` internally (Injected/Utils.js:1694,
   `enforceLidAndPnRetrieval`) and does network fallback via `queryWidExists`.
   The current server.js code instead uses a `msg.getContact()` heuristic — see
   §1.9 for why that's shaky.
6. **`wa_contact_ids` table + helpers exist and are correct** (commit
   `721c8a4`): every QR inbound saves the exact original id (`...@lid` /
   `...@c.us`) keyed `(business_id, phone)`; `sendWhatsAppToCustomer`'s QR
   branch prefers the stored `wa_id` over bare digits. This is the durable
   mechanism that makes initiated sends (re-engagement etc.) reachable for LID
   customers. It only has rows for messages received AFTER it deployed
   (2026-08-01). Keying consistency depends on §3.
7. **A complete Chromium-free QR backend already exists**:
   `data/baileys-wa.js` (@whiskeysockets/baileys `^7.0.0-rc.13`, in
   package.json), switched by env `WA_QR_BACKEND=baileys`, same interface as
   waweb.js (startClient/sendText/getStatus/stopClient), sends resolve bare
   digits via `sock.onWhatsApp()`, reply path preserves exact JIDs. **Never
   yet run in production — status unknown.** Relevant because: (a) ~20MB vs
   ~200MB Chromium — the 414MB box's whole stability problem; (b) it needs
   none of Chromium's apt libs — sidesteps zordical.com's `libcairo` breakage
   entirely; (c) Baileys v7 exposes the sender's real phone alongside a LID
   (check `msg.key.senderPn` / `remoteJidAlt` on the message key — verify
   against the installed version's types before relying on it).
8. **whatsapp-web.js `Contact.id` is a Wid OBJECT** (`{server, user,
   _serialized}`), not a string. `String(contact.id)` → `"[object Object]"`.
   `getContactModel` substitutes `res.id = contact.phoneNumber` **only when
   WhatsApp has the phone mapping** (Injected/Utils.js:1008-1016).
9. **⚠️ Commit `290dd8e`'s message contains a WRONG diagnosis.** It claims
   `contact.id` returned unrelated 15-digit numeric ids that corrupted
   profiles. Re-examination: those 15-digit profile keys are simply the RAW
   LID digits stored by `updateCustomerProfile` (fact 2) and their
   `lastActive` timestamps predate that fix's deploy. The strict-shape
   validation that commit added is still correct and should stay, but do not
   build any reasoning on its commit message. What `getContact()` actually
   returns for an @lid sender in production has **never been observed** —
   §2's diagnostic settles it.
10. **Current @lid resolution code** (server.js `startQrClientForBranch` →
    `onMessage`, ~line 2520-2560): 5s `Promise.race` timeout around
    `msg.getContact()` (a hung CDP call once stalled ALL message processing —
    commit `07c6b35`), strict shape guard `/^(?:91)?([6-9]\d{9})$/`, falls
    back to LID digits, then `db.saveWaContactId(branchId, fromPhone, from)`.
11. **Re-engagement timings** (server.js constants): check-in at 10 min
    silence, same-day-expiring offer at +15 min more, sweep every 60s, once
    per idle conversation, tracked in `reengagement_state` anchored to the
    last outbound `chat_messages` row. `userStates` (reservation-track info)
    is in-memory and lost on every restart — the sweep then falls back to the
    generic "browser" track by design.
12. **`process.env.TZ = process.env.TZ || 'Asia/Kolkata'`** is set at the top
    of data/server.js (commit `290dd8e`). Side effects, all wanted:
    `msUntilLocalMidnight()` → same-day coupons now expire at IST midnight
    (was UTC midnight = 5:30 AM IST); `aiUsageDateKey()` → the 30/day Claude
    cap resets at IST midnight. SQLite `CURRENT_TIMESTAMP` remains UTC — that
    is fine and by design; fix at display, not storage (§5).
13. **manager.html time rendering**: `fmtChatTime(c.created_at)` →
    `new Date(str).toLocaleTimeString('en-IN',…)` (manager.html ~1911, ~2009)
    and orders `new Date(o.created_at).toLocaleString('en-IN',…)` (~3131) all
    parse the zone-less UTC string as local → 5.5h off. Other staff pages
    (hq.html, owner.html, portal.html, kitchen.html) likely share the pattern
    — audit in §5.
14. Recent commit chain for context: `694d2c3` re-engagement feature +
    price-first Rule 8 → `381c83c` first @lid fix (unbounded getContact, loose
    validation) → `721c8a4` wa_contact_ids → `07c6b35` 5s timeout → `290dd8e`
    strict shape + TZ. All deployed to zordic.in; zordical.com is at `694d2c3`
    unless the user has pulled since (**verify with `git log -1 --oneline`
    before reasoning about either box**).

**STOP RULES**
- **S1**: Before ANY destructive/bulk write on zordic.in (SQL UPDATE/DELETE,
  rewriting customer_profiles.json): print row counts of what will change,
  take file copies (`cp data/cafe_hq.db data/cafe_hq.db.bak-<date>` + the
  JSON), and show the user the plan. Its 5 businesses are real tenants.
- **S2**: Never merge two customer profiles automatically (loyalty-point
  misattribution risk — explicit user concern). Report merge candidates;
  the user decides.
- **S3**: Don't switch a production box's QR backend, or reconnect/unlink a
  café's WhatsApp, without the user's go-ahead — a backend switch forces a
  fresh QR scan by the café owner's phone.
- **S4**: Anything touching real WhatsApp behavior cannot be tested locally
  (no WA credentials in dev). Local = logic tests only; production = the user
  runs your command / sends a test message and pastes output. Say so plainly
  in your reports rather than claiming verification you don't have.
- **S5**: Leave test cafés in place (standing instruction), and never commit
  `data/businesses.json` or test-café dirs — stage only real source files.
- **S6**: Single-line `&&`-chained SSH commands only (the Lightsail browser
  terminal corrupts multi-line pastes, and copying domain-shaped text from
  rendered chat picks up markdown link syntax). Node one-liners with nested
  quotes survive best as `node -e "…'…'…"` double-outside/single-inside.

---

## §2 — Phase W0: one diagnostic before touching resolution code

Goal: observe, once, what the installed library actually returns for a real
@lid sender. Add a TEMPORARY log in the `@lid` branch of `onMessage`
(server.js ~2534), right after the existing getContact race:

```js
try {
  const pairs = await Promise.race([
    waweb.clients?.[branchId]?.client?.getContactLidAndPhone([from]),
    new Promise((_, rej) => setTimeout(() => rej(new Error('lidpn timeout')), 5000)),
  ]);
  console.log('[LID DIAG]', from, JSON.stringify(pairs));
} catch (e) { console.log('[LID DIAG] failed:', e.message); }
```

(Adapt the client access to waweb.js's actual export shape — it keeps a
per-branch `clients` map internally; you may need to export a small
`getClient(branchId)` accessor from waweb.js instead of reaching in.)

Deploy to zordic.in, have the user send a WhatsApp message **from a personal
number that has previously produced an @lid row**, read the pasted log. Two
outcomes:
- `pn` comes back (`"91xxxxxxxxxx@c.us"`): proceed to W1 exactly as written.
- `pn` is null/undefined: WhatsApp genuinely doesn't expose that sender's
  number to this linked account. W1 still ships (it helps every case where pn
  IS available), but set expectations with the user: for pn-less senders the
  portal can only ever show a "WhatsApp private user" label (§4), never a real
  number — that's WhatsApp's privacy working as intended, not a bug.

Remove the diagnostic in the same session it's confirmed (the repo has a
history of temporary logs being caught before commit — keep that record clean).

## §3 — Phase W1: resolution + one canonical phone key

**W1a — replace the heuristic with the purpose-built API.** In `onMessage`'s
@lid branch: call `getContactLidAndPhone([from])` (5s race, same pattern),
take `pairs[0].pn`, strip the domain, then apply the EXISTING strict shape
guard `/^(?:91)?([6-9]\d{9})$/` as belt-and-braces before accepting. Keep the
current fallback-to-LID-digits + warn behavior. Keep `msg.getContact()` out of
it entirely. Keep the `db.saveWaContactId(...)` call — it must record the
original `from` id regardless of resolution outcome.

**W1b — one canonical key everywhere.** Canonical form = `db.normalizePhone`
(last-10). Apply it at every identity boundary so the same human always lands
on one key:
- `updateCustomerProfile`: normalize `phone` on entry, and match existing
  profiles by `normalizePhone(p.phone) === normalizePhone(phone)` so old
  raw-keyed entries still match rather than duplicating (full re-key of old
  data happens in §4, not here).
- `wa_contact_ids` save/get: normalize the `phone` key at both call sites (the
  `wa_id` value itself stays the full original id — that's its whole point).
- `sendWhatsAppToCustomer`: normalize before the `getWaContactId` lookup.
- `emitToBranch('inbound_chat', …)` payloads and anything else in the QR
  handler that carries `fromPhone`.
- Grep `customer_profiles.json` readers (CRM routes, at-risk, insights) for
  raw-equality phone matching and normalize there too.

Note: `91`-prefixed 12-digit values (Cloud API's `message.from` format)
normalize to the same last-10 — that's the point; cross-channel identity
converges.

**W1c — local verification** (the part that CAN be tested locally): extend the
existing scratchpad pattern — a logic test over the resolution function with
mocked `getContactLidAndPhone` responses (pn present / null / timeout / throw),
plus a live local server test that a web-chat conversation and a simulated
12-digit-Cloud-style phone land on one profile. `node -c` both files. Then
deploy to zordic.in and re-run the §2 live test end-to-end: user messages from
an @lid number → portal shows the real number (or the documented fallback).

## §4 — Phase W2: historical data cleanup (zordic.in — S1 applies to all of it)

Classify every distinct phone key across `customer_profiles.json` (all 5
branch dirs), `chat_messages`, `loyalty_points`, `reengagement_state`,
`wa_contact_ids`:

- **Class A — certain garbage**: ≥11 digits and not `91`+10 (i.e. 13-15 digit
  raw LIDs; also the 12-digit check must survive `91`-prefixed real numbers),
  or 10 digits starting 0-5. Actions:
  - `reengagement_state` rows with a Class-A phone and NO matching
    `wa_contact_ids` row: DELETE (they can never send; they make the sweep
    retry-spam the logs forever — this exact noise misled two rounds of
    debugging already).
  - `customer_profiles.json` entries: re-key raw-LID entries to their
    normalized last-10 form (merging INTO an existing same-key entry only if
    that entry is itself the truncated twin of the same LID — fact §1.3 pairs;
    that's the one merge that's provably the same person). Where no real
    number can ever be known, set `name` untouched and add
    `waPrivate: true` so the UI can label instead of showing digits.
  - `chat_messages`: leave rows as-is (history is history; re-keying breaks
    nothing if readers normalize per W1b — verify the chat-history reader
    groups by normalized phone before deciding you're done).
- **Class B — ambiguous** (10 digits starting 6-9 that appear only in
  WhatsApp-channel rows and might be LID truncations): DO NOT touch. Produce a
  short report listing them with names/lastActive so the user can recognize
  real customers. S2 applies.

Print before/after counts for every mutation. Back up first (S1).

## §5 — Phase T1: finish the timezone fix (display path)

The robust, smallest-blast-radius fix: make the SERVER append a zone marker
when serving SQLite timestamps, so browsers parse correctly no matter where
they run. Precedent already in the codebase: `sqliteTimeToMs()` in server.js
does `.replace(' ', 'T') + 'Z'`.

1. Grep every API route that returns `created_at` / `submitted_at` /
   `issued_at` etc. from SQLite to staff UIs (chat-history route in
   marketing.js, orders list, loyalty activity, events). Convert to ISO-Z in
   the response (`row.created_at.replace(' ','T')+'Z'`) — or add one shared
   `toIsoZ()` helper in the route ctx.
2. Audit the staff pages (manager.html ~1911/2009/3131 first, then hq.html,
   owner.html, portal.html, kitchen.html) for `new Date(<api string>)` on
   those fields — once the API emits ISO-Z, `toLocaleTimeString('en-IN',…)`
   renders correct IST automatically; remove any client-side hacks found.
3. Do NOT change SQLite storage to local time, and don't blanket-shift stored
   rows — UTC storage + zoned display is correct. The only stored-string
   casualty is pre-fix `lastActive` locale strings in profiles; shifting them
   is optional/low-value — skip unless the user asks.
4. Re-verify after deploy: user opens Customer Chats, times match their phone.
   Also confirm a fresh same-day re-engagement coupon's `expires_at` lands at
   IST midnight (`18:30:00Z`).

## §6 — Phase S1: stability decision (user gate — present options, then wait)

The 414MB box corrupts Chromium sessions under restart pressure (observed:
`SingletonLock` "browser already running", detached-frame errors, LOGOUT).
Three options to put to the user:

- **A (recommended first move, ~zero cost): switch QR backend to Baileys** —
  set `WA_QR_BACKEND=baileys` in `.env`, `pm2 restart --update-env`, café
  re-scans QR once. Eliminates Chromium (RAM + the libcairo problem class).
  Try it on **zordical.com's `roasted_bean_ms7jj29g` first** — that café's QR
  is already broken (libcairo), so it's a free trial run on a disposable café;
  verify inbound → AI reply → initiated send (re-engagement) → whether LID
  senders arrive with `senderPn`. If clean for a day, offer the same switch on
  zordic.in.
- **B: RAM upgrade** for zordic.in (Lightsail snapshot → larger instance →
  move static IP). Costs money; fixes the class generally.
- **C: Cloud API reconnect** for the affected café (needs the owner to redo
  Meta token work; no LID problem exists on Cloud at all).

## §7 — Acceptance test (production, end-to-end — the feature has NEVER passed this)

With the user, from a fresh personal number:
1. Message the café → AI replies (prices stated plainly, no unprompted offers
   — Rule 8).
2. Portal Customer Chats shows a REAL phone number (or "WhatsApp private
   user" label) and correct IST timestamps.
3. Go silent mid-flow → ~10-11 min later the soft check-in arrives on the
   phone (no discount in it).
4. Stay silent → ~15-16 min after the check-in, the offer arrives with a
   `BACK-…` coupon code; `coupons.expires_at` = today IST midnight;
   `reengagement_state.stage` = `offer_sent`; exactly ONE coupon row for the
   cycle (idempotency held).
5. Reply → thread clears; no further nudges for that conversation.
6. Regression: web-chat widget conversation still works and lands on the same
   normalized profile; a Cloud-API café (if any connected) is unaffected.

## §8 — Ops crib sheet

- Stuck whatsapp-web.js session reset (forces re-scan):
  `pm2 stop zordic && (pkill -f "session-<branchId>" || true) && rm -rf ~/zordic/.wwebjs_auth/session-<branchId> ~/zordic/.wwebjs_cache && pm2 start zordic`
- Log check: `grep -iE "wa qr|no lid|reengagement|lid diag" ~/.pm2/logs/zordic-*.log | tail -30`
- DB peek (S6 quoting):
  `cd ~/zordic && node -e "const db=require('./data/db.js');const raw=db.raw();console.log(JSON.stringify(raw.prepare('SELECT * FROM wa_contact_ids').all(),null,2))"`
- Tool gotchas in this environment: Grep/Read sometimes renders `/` as `\` in
  output (display artifact — verify via `node -c` or exact Edit-match before
  believing it); `preview_start({name})` breaks on the OneDrive path (start
  servers via Bash + `preview_start({url})` instead); local
  `ANTHROPIC_API_KEY` is a dead placeholder (AI replies locally come from
  Gemini or keyword tier).
- Commit style: stage only source files; end commit messages with the
  Co-Authored-By line per harness instructions; push `origin master`; then
  hand the user the deploy line(s) for whichever box(es) need it.
