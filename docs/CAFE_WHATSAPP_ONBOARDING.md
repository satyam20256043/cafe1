# Café WhatsApp Onboarding Playbook

The standard process for connecting a real café's WhatsApp to Zordic with a
**permanent (never-expiring) token** and a **real business number**. Follow it
top to bottom for every new café. Written 2026-07-10, after the first full
integration was debugged end-to-end — the Troubleshooting section at the bottom
exists because every one of those failures actually happened.

**Zordic side, for reference:** each café's credentials live in
`data/<branchId>/whatsapp_config.json` (`phoneNumberId` + `accessToken`), saved
from Manager Dashboard → Settings → WhatsApp. Inbound messages are routed to a
café by matching the `phone_number_id` Meta sends against each café's saved
value. The webhook (`https://zordic.in/api/webhook/whatsapp`) is registered
ONCE for the whole platform — never per café.

---

## Part 0 — Decide whose Meta Business Portfolio hosts the number

Two workable models while Zordic is small:

- **Café-owned (preferred):** the café owner creates their own free Meta
  Business Portfolio at business.facebook.com. They own their number, their
  WABA, their data. You guide them through the steps below inside *their*
  portfolio (usually on a screen-share or in person).
- **Zordic-hosted (pragmatic):** the number is added under *your* portfolio /
  WABA as an additional phone number. Faster, but all cafés legally message
  "on behalf of" your business, and an unverified WABA holds only ~2 numbers.
  Use only for pilots.

Long-term (5+ paying cafés): register as a Meta **Tech Provider** and implement
**Embedded Signup** so owners connect with one click. Out of scope for now.

---

## Part 1 — Permanent token (System User) — ~10 minutes

The 24-hour tokens on the developer API Setup page are for testing only. Real
cafés get a **System User** token that never expires.

1. Go to **business.facebook.com** → ⚙️ **Business Settings** (in the portfolio
   that owns the app and WABA).
2. Sidebar → **Users → System Users** → **Add**. Name: `zordic-bot`,
   role: **Admin**.
3. Select the system user → **Add Assets**:
   - **Apps** → the Meta app → **Full control (Manage app)**.
   - **WhatsApp Accounts** → the WABA → full control.
4. **Generate New Token**:
   - App: the Meta app.
   - **Token expiration: NEVER** ← the entire point.
   - Permissions: ✅ `whatsapp_business_messaging` ✅ `whatsapp_business_management`
   - Generate → **copy immediately** (Meta shows it exactly once).
5. Paste into the café's **Manager → Settings → WhatsApp → Access Token**
   (with the Phone Number ID), Save, then click **Test** — must succeed.
6. **Verify the WABA is subscribed to OUR app** (see Troubleshooting #3 — this
   silently breaks inbound and has already bitten us once):

   ```
   curl -s "https://graph.facebook.com/v18.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <TOKEN>"
   ```

   The response must list *your* app's name. If it's empty or shows
   "WA DevX Webhook Events 1P App", run the same URL as `-X POST` → expect
   `{"success":true}`.

**Token discipline:** the token is a master key to the WABA. It lives ONLY in
`data/<branchId>/whatsapp_config.json` on the server. Never in git, never in
chat, never in a screenshot. If ever exposed: Business Settings → System Users
→ revoke, generate a new one, update Settings.

## Part 2 — Real phone number (leaving the test sandbox)

1. **WhatsApp → API Setup → Add phone number**: café's business number,
   display name (e.g. "Brew Haus Café"), business category.
2. ⚠️ The number must NOT be actively registered on the normal WhatsApp /
   WhatsApp Business app. If it is, the owner must delete that WhatsApp account
   first (WhatsApp app → Settings → Account → Delete account). Chats can be
   exported first, but a number can only live in one place.
   **Most cafés should just buy a fresh SIM for the AI receptionist** instead
   of sacrificing a number customers already chat with.
3. Verify ownership via SMS/voice OTP on that number.
4. The display name goes through a short Meta review (usually < 1 day).
5. Copy the **new number's Phone Number ID** into the café's Zordic Settings
   (the ID changes — it is per-number, not per-account) and re-run the
   Part 1 step 6 `subscribed_apps` check.
6. Once a real number is registered there is **no allow-list** — any customer
   can message it. Unverified businesses get ~250 new customer conversations
   per 24h (fine for a café starting out).

## Part 3 — Business verification (only when scale demands)

**Business Settings → Security Centre → Start Verification** — upload business
documents (GST/registration + address proof). Unlocks: 1,000+ conversations/day
tiers, more numbers per WABA, green-tick eligibility. Skip on day one; do it
when a café is nearing the 250/day ceiling.

## Part 4 — Final end-to-end check (do every time, takes 2 minutes)

1. From any phone, WhatsApp the café's number: "what time do you close?"
   → AI must reply within seconds.
2. Check the conversation appears in Manager → **Customer Chats** (live).
3. Send "the food was cold, I want a refund" → owner must get the escalation
   on their WhatsApp + the "Needs You" card on the Overview tab.
4. `pm2 logs zordic --lines 20 --nostream` on the server — no `[WA Webhook]` /
   `[WA Cloud API]` errors.

---

## Troubleshooting — the three silent failure modes (all seen in production)

All three have the **identical symptom** — "the AI doesn't reply" — and none of
them produce an error in Meta's UI. Check in this order:

1. **Webhook verify token mismatch** (only relevant when re-registering the
   webhook, which is platform-level and rare). Server-side proof the token is
   right: `curl "https://zordic.in/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=x"`
   → must return 200 + `x`. Always copy-paste the token — it's 49 chars.

2. **`messages` webhook field not subscribed** (App Dashboard → WhatsApp →
   Configuration → Webhook fields). The **Test button works even when NOT
   subscribed** — it sends a dummy payload with `phone_number_id: 123456123`
   (that fake ID in the logs = dashboard test, not a real message). The row
   must actually say **Subscribed**.

3. **WABA subscribed to the wrong app** — the nasty one. The WABA can end up
   subscribed to Meta's internal **"WA DevX Webhook Events 1P App"** instead of
   ours, so Meta delivers all inbound messages to its own app: outbound works,
   webhook verifies, `messages` shows subscribed, yet ZERO inbound POSTs reach
   the server. Diagnose and fix with the `subscribed_apps` GET/POST in Part 1
   step 6. **Check this proactively for every new café.**

**How to read the server logs when debugging:**

- `pm2 logs --lines N` tails old history too — a fresh test needs
  `pm2 logs zordic` left streaming while you send the message.
- No new `[WA Webhook]` line at all when you message → Meta isn't delivering
  (causes #2 or #3 above, or the sender isn't allow-listed on a test number,
  or the wrong number was messaged).
- `[WA Webhook] No branch configured for phone_number_id: <15-16 digits>` →
  message IS arriving; the ID doesn't match what's saved in that café's
  Settings. Copy the logged ID into Settings → WhatsApp verbatim.
- `[WA Cloud API] Send error ...` → inbound is fine; the reply failed —
  almost always an expired/invalid token (24h test tokens!). Regenerate and
  re-save.

## Test-tier quirks (only while using Meta's test number)

- Tokens from the API Setup page **expire every 24 hours**.
- Only **allow-listed** recipient numbers work (API Setup → "To" field →
  Manage phone number list → OTP-verify each).
- Customers must message the **Meta test number** (+1 555…), not your real one.
- All three quirks disappear after Part 1 + Part 2.
