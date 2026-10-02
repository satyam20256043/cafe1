# Google Business Profile engine — connect, reviews, audit, posts, insights (GB0–GB10)

**For: a Claude Sonnet session.** Repo `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`,
branch `master`. Work in `data/` and `public/` only — root `server.js` is frozen legacy
(`package.json` `main` is `data/server.js`). Commit after each package.

Operator decisions already settled — **do not reopen**:

- Target verticals for now: **cafés, restaurants, hotels.** Review topic lists and
  copy in this guide cover those three only.
- **The existing WhatsApp Google-review reward flow stays exactly as it is**
  (`GOOGLE_REVIEW_PENDING` / `GOOGLE_REVIEW_NAME_PENDING` in `data/server.js`, the
  `google_review_claims.json` approve/reject routes in `data/routes/marketing.js`).
  Do not edit, gate, rename or "improve" it in any package below.
- **No AI reply or post is ever published without a human tapping Publish.**
  (Autonomy level 3 — "AI drafts, human approves".) Auto-publish is out of scope.
- Talk to Google with plain `fetch` (Node ≥18 global). **No `googleapis` dependency.**
- Google API access is being applied for in parallel. Everything is built and
  verified against a **mock adapter** first, then switched to live with one env var.

This is Phase A of the cafés/restaurants/hotels roadmap. Phase B (Instagram/Facebook
content studio) and Phase C (attribution, owner daily briefing) get their own guides.

---

## §0 — Why this exists

The manager portal has a **"🔄 Sync Google Reviews"** button that looks like a Google
integration but is not one. There is no OAuth, no token, no Google API call anywhere
in the codebase. Phase A replaces the stub with a real Business Profile connection:
real reviews, AI-drafted replies the owner approves from their phone, a profile
health audit, Google posts, and Google performance numbers next to Zordical's own
order data.

### Verified facts (read directly, 2026-10-03)

1. ⚠️ **The current "sync" injects fabricated reviews into a café's real feedback.**
   `data/routes/marketing.js:457` `POST /api/businesses/:id/gbp/sync` pushes a
   hard-coded array of three reviews (`'Aditya Sen'`, `'Meera Kapoor'`,
   `'Kabir Dev'`, all `source: 'google'`) into `feedback.json`, then hands a
   `REVIEW15` coupon to any CRM profile whose name happens to match, and emits a
   fake `inbound_chat` "to simulate that the bot sent them a WhatsApp message".
   A real café pressing this button gets fake Google reviews in its dashboard.
   **GB0 deletes this.**

2. **The "link" route is a URL setter, not a connection** —
   `data/routes/marketing.js:428` `POST /api/businesses/:id/gbp/link` sets
   `settings.gbpLinked = true` and `settings.gbpLocationId = locationId` in the
   branch's `settings.json`, and if the value starts with `http` also overwrites
   `businesses[i].review`. `data/routes/business.js:193-197` sets the same two
   flags whenever the owner saves a review URL in Settings.

3. **The manager UI calls both stub routes back-to-back** — `public/manager.html:2913`
   `async function syncGBP()` POSTs `/gbp/link` with `locationId: business.review||'linked'`
   then `/gbp/sync`. The button is at `public/manager.html:758`, inside
   `<div id="tab-feedback">` (`:754`). `loadFeedback()` is at `:2844`.

4. **`business.review` is the café's public review URL and must keep working.**
   It is read by the AI prompt (`data/server.js:822`), the review-reward flow
   (`:1602-1606`, `:1673`, `:1795-1807`), and the review-link reply (`:2165-2167`).
   The Google connection added here is **separate** from that URL. Never overwrite
   `business.review` from any Google code path.

5. **Dead schema columns** — `data/db.js:127-128`, table `settings`:
   `gbp_linked INTEGER DEFAULT 0`, `gbp_place_id TEXT`. Unused. Leave them; new
   state goes in the new `google_connections` table (GB1).

6. **Feedback reply route (local only)** — `data/routes/marketing.js:393`
   `POST /api/businesses/:id/feedback/:feedbackId/reply` writes `managerReply` into
   `feedback.json`. It never touched Google. Keep it for in-app (WhatsApp) feedback;
   Google replies get their own route (GB7).

7. **AI helper** — `data/server.js:923` `async function callClaude(prompt)`:
   single user message, `max_tokens: 500`, wrapped in `withLlmRetry`, returns
   trimmed text or `null`. Already on `routeCtx` (`:2438`), alongside `callGemini`.
   Never throws — callers must handle `null`.

8. **Route wiring** — `routeCtx` object at `data/server.js:2438`; route modules are
   mounted at `:2468-2479` as `require('./routes/<name>')(routeCtx)`. Auth middleware
   on ctx: `requireAuth`, `requireBranchAccess` (`:2424` — admin/agency_admin pass
   everything; other staff only their own `businessId`), `requireRole(...roles)`
   (`:2416`). `signToken` / `verifyToken` are on ctx too.

9. **Schema migration shape** — `data/db.js:345` `(function migrateColumns() { const cols = [ ['table','column','TYPE'], ... ]`.
   New *tables* go in the main `CREATE TABLE IF NOT EXISTS` schema block (same file,
   e.g. `events` at `:157`). `logEvent(businessId, eventType, { customerPhone, actor, metadata })`
   at `:1290`. Raw handle: `db.raw().prepare(sql).all(...)` — `db.raw()` takes no args.

10. **Schedulers are plain `setInterval`/`setTimeout`** in `data/server.js`
    (e.g. `:3311` weekly growth suggestions, `:3331` trial reminders, `:3337`
    `setInterval(sweepReengagementNudges, 60 * 1000)`). There is no job queue.
    GB5/GB9/GB10 follow the same pattern.

11. **No encryption helper exists** — no `createCipheriv` anywhere in `data/`.
    GB2 adds one. `.env.example` has `BASE_URL=http://localhost:3010`.

12. ⚠️ **`ctx.db` is the whole `db.js` exports object, not better-sqlite3.**
    `db.prepare(...)` crashes; always `db.raw().prepare(...)`. This has bitten
    `backup.js` and `marketing.js` before.

---

## §1 — STOP RULES

- **S1 — Never fabricate.** No code path may write a review, rating, metric or post
  that did not come from Google (live) or from the mock adapter (mock mode). Mock
  data must be visibly labelled in the UI (GB3). If you can't get real data, show
  an empty state that says so.
- **S2 — Tokens never leave the server.** Access/refresh tokens are encrypted at
  rest (GB2), never returned by any API response, never logged, never put in a URL,
  never emitted over socket.io. `GET .../google/status` returns flags and timestamps
  only.
- **S3 — Never trust the browser for tenant.** The OAuth `state` parameter is a
  signed token carrying `businessId` (GB4). The callback reads the business from the
  verified state, never from a query param.
- **S4 — Human approval before anything reaches Google.** Review replies and posts
  are published only by an explicit owner/manager request to a publish endpoint.
  Schedulers may *publish already-approved scheduled posts*; they never approve.
- **S5 — The review-reward flow is untouched.** If a package seems to require editing
  `GOOGLE_REVIEW_PENDING`, `GOOGLE_REVIEW_NAME_PENDING`, or the
  `/google-review/:claimId/approve|reject` routes, **stop and report.**
- **S6 — `business.review` is never written by Google code** (§0.4).
- **S7 — Mock mode is impossible in production.** If `GOOGLE_MODE=mock` and
  `NODE_ENV=production` (or `BASE_URL` starts with `https://zordical.com` or
  `https://zordic.in`), the adapter refuses to load and Google features report
  "not configured". Never fall back from live to mock on error.
- **S8 — Anchor mismatch.** If any line reference in §0 doesn't match what you read,
  re-locate by the quoted code. If the code itself is different, **stop and report**.
- **S9 — Google endpoint shapes.** The endpoint URLs in GB3 were correct when
  written. Before GB3, check the current Google Business Profile API docs. If an
  endpoint moved or changed shape, adapt **only inside `data/integrations/google.js`**
  and note it in the commit message. If a capability (e.g. reviews, local posts) is no
  longer offered, **stop and report**.
- **S10 — Start from a clean tree.** `git status` currently shows many modified
  files from earlier work. Do not start GB0 until the operator has committed or
  stashed them; ask if unsure.

---

## §2 — Operator prerequisites (user-side, not code)

Needed only for **live** mode. GB0–GB10 are all buildable and verifiable in mock mode
without any of this.

1. Google Cloud project → enable: *My Business Account Management API*,
   *My Business Business Information API*, *Business Profile Performance API*, and
   *Google My Business API* (v4 — reviews and local posts still live there).
2. OAuth consent screen (External), scope `https://www.googleapis.com/auth/business.manage`.
3. OAuth client (Web). Authorized redirect URIs:
   `https://zordical.com/api/google/oauth/callback` and
   `http://localhost:3010/api/google/oauth/callback`.
4. Submit the **Business Profile API access request** (Google approves per project;
   until approved, quota is 0 and every call fails even with valid OAuth). Approval
   can take weeks.
5. `.env` on the server (generate the key with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — a
   **different** key per environment; never copy the local one to production):
   ```
   GOOGLE_MODE=live
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://zordical.com/api/google/oauth/callback
   TOKEN_ENCRYPTION_KEY=<64 hex chars>
   ```
   Then `pm2 restart zordical --update-env` (plain restart does not reload env).
   Paste long secrets inside `nano`, never on the shell line (the Lightsail web SSH
   has truncated keys before).

Add the five variables, commented and empty, to `.env.example` in GB2.

---

## GB0 — Remove the fake sync

1. `data/routes/marketing.js:457` `POST /api/businesses/:id/gbp/sync`: delete the
   whole body (fabricated array, CRM coupon matching, simulated `inbound_chat`).
   Replace with a thin delegate that calls the real sync once GB5 exists. For GB0
   alone, return
   `res.status(409).json({ error: 'Connect Google Business Profile first', code: 'GOOGLE_NOT_CONNECTED' })`.
2. `data/routes/marketing.js:428` `POST /gbp/link`: **leave in place** for now —
   `business.js` still sets the same flags. GB4 stops the UI calling it. Add a
   one-line comment: `// Legacy URL-only "link". Real connection: routes/google.js.`
3. `public/manager.html:2913` `syncGBP()`: remove the `/gbp/link` call. On a 409,
   toast "Connect Google in Settings first" instead of "Synced N review(s)".
4. Existing fake rows: they may already sit in real cafés' `feedback.json` with ids
   `g1`/`g2`/`g3` and `source: 'google'`. Write a one-off script
   `data/scripts/remove_fake_gbp_reviews.js` that, for every branch dir, removes only
   entries matching **all of** `source === 'google'`, `id ∈ {'g1','g2','g3'}`, and
   `customerName ∈ {'Aditya Sen','Meera Kapoor','Kabir Dev'}`. Print what it would
   remove with `--dry-run` (the default). Only `--apply` writes. Do **not** run
   `--apply` on any server. That's the operator's call.

**Verify:** local test café → Feedback tab → Sync button → toast says connect first,
`feedback.json` unchanged. Dry-run the script against local `data/` and paste the output.

## GB1 — Schema

Add to the `CREATE TABLE IF NOT EXISTS` block in `data/db.js`:

```sql
CREATE TABLE IF NOT EXISTS google_connections (
  business_id        TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'pending_location', -- pending_location | connected | needs_reconnect | disconnected
  google_email       TEXT,
  account_name       TEXT,       -- "accounts/123"
  location_name      TEXT,       -- "locations/456"
  location_title     TEXT,
  maps_uri           TEXT,
  access_token_enc   TEXT,
  refresh_token_enc  TEXT,
  token_expires_at   INTEGER,    -- epoch ms
  last_sync_at       TEXT,
  last_sync_error    TEXT,
  connected_at       TEXT,
  connected_by       TEXT,       -- staff id
  updated_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS google_reviews (
  review_name     TEXT PRIMARY KEY,   -- Google's "accounts/../locations/../reviews/.." — external id, dedupe key
  business_id     TEXT NOT NULL,
  reviewer_name   TEXT,
  reviewer_photo  TEXT,
  star_rating     INTEGER,            -- 1..5 (Google sends ONE..FIVE — convert)
  comment         TEXT,
  create_time     TEXT,
  update_time     TEXT,
  reply_text      TEXT,               -- the reply currently live on Google, if any
  reply_time      TEXT,
  sentiment       TEXT,               -- positive | neutral | negative
  topics          TEXT,               -- JSON array
  ai_draft        TEXT,
  draft_status    TEXT DEFAULT 'none',-- none | drafted | publishing | published | failed | skipped
  publish_error   TEXT,
  replied_by      TEXT,               -- staff id who published via Zordical
  synced_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_greviews_biz_time   ON google_reviews(business_id, create_time);
CREATE INDEX IF NOT EXISTS idx_greviews_biz_status ON google_reviews(business_id, draft_status);

CREATE TABLE IF NOT EXISTS google_posts (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL,
  topic_type      TEXT NOT NULL DEFAULT 'STANDARD', -- STANDARD | OFFER | EVENT
  summary         TEXT NOT NULL,
  cta_type        TEXT,               -- CALL | ORDER | BOOK | LEARN_MORE | null
  cta_url         TEXT,
  title           TEXT,               -- event / offer title
  start_date      TEXT,
  end_date        TEXT,
  coupon_code     TEXT,
  image_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | publishing | published | failed | rejected
  scheduled_for   TEXT,               -- ISO UTC; null = publish on approve
  google_post_name TEXT,
  attempts        INTEGER DEFAULT 0,
  last_error      TEXT,
  ai_generated    INTEGER DEFAULT 0,
  created_by      TEXT,
  approved_by     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gposts_biz_status ON google_posts(business_id, status);
CREATE INDEX IF NOT EXISTS idx_gposts_due        ON google_posts(status, scheduled_for);

CREATE TABLE IF NOT EXISTS google_daily_metrics (
  business_id  TEXT NOT NULL,
  date         TEXT NOT NULL,         -- YYYY-MM-DD
  metric       TEXT NOT NULL,         -- Google DailyMetric enum name
  value        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, date, metric)
);

CREATE TABLE IF NOT EXISTS google_audits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL,
  score        INTEGER NOT NULL,
  findings     TEXT NOT NULL,         -- JSON (see GB8)
  created_at   TEXT DEFAULT (datetime('now'))
);
```

Add small accessor functions to `db.js` and export them (follow the existing export
list style): `getGoogleConnection`, `upsertGoogleConnection`, `upsertGoogleReview`
(returns `{ inserted: boolean }` so GB5 can detect new reviews), `listGoogleReviews(businessId, { filter, limit, offset })`,
`updateGoogleReviewDraft`, plus equivalents for posts and metrics. All queries filter
by `business_id`. `listGoogleReviews` is paginated (default 20, max 100). Never return all rows.

**Verify:** boot twice on an existing DB with no errors. `sqlite3`/`node -e` shows the
five tables and four indexes.

## GB2 — Secret encryption

New file `data/secrets.js`:

- `encrypt(plaintext) → 'v1:<iv_b64>:<tag_b64>:<ct_b64>'` and `decrypt(str)`,
  AES-256-GCM, 12-byte random IV, key = `Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex')`.
- `isConfigured()` → true only if the key is exactly 64 hex chars.
- `decrypt` throws on tamper/wrong key. Callers catch it and mark the connection
  `needs_reconnect`. Never crash the server.
- Never log inputs or outputs.

Add the §2 env vars to `.env.example`, commented, empty values.

**Verify:** `node -e` round-trip test; a flipped ciphertext byte throws; missing key →
`isConfigured() === false`.

## GB3 — Google adapter (+ mock)

`data/integrations/google.js`: the **only** file that knows Google URLs.

```js
module.exports = function createGoogleAdapter({ mode }) { return {
  mode,                                   // 'live' | 'mock'
  getAuthUrl(state),                      // access_type=offline, prompt=consent, include_granted_scopes=true
  exchangeCode(code),                     // → { accessToken, refreshToken, expiresAt, email }
  refreshAccessToken(refreshToken),       // → { accessToken, expiresAt }
  revoke(token),
  listAccounts(accessToken),              // → [{ name, accountName }]
  listLocations(accessToken, accountName),// → [{ name, title, address, mapsUri }]
  getLocation(accessToken, locationName), // → normalized profile for the audit (GB8)
  listReviews(accessToken, accountName, locationName, pageToken),   // → { reviews:[normalized], nextPageToken, averageRating, totalReviewCount }
  replyToReview(accessToken, reviewName, comment),
  deleteReply(accessToken, reviewName),
  createLocalPost(accessToken, accountName, locationName, post),    // → { name }
  fetchDailyMetrics(accessToken, locationName, metrics, startDate, endDate), // → [{ date, metric, value }]
}; };
```

Live endpoints (check per S9):

| Call | Endpoint |
|---|---|
| auth | `https://accounts.google.com/o/oauth2/v2/auth` |
| token / refresh | `POST https://oauth2.googleapis.com/token` |
| revoke | `POST https://oauth2.googleapis.com/revoke` |
| userinfo email | `GET https://openidconnect.googleapis.com/v1/userinfo` (add `openid email` scopes) |
| accounts | `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` |
| locations | `GET https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations?readMask=name,title,storefrontAddress,metadata` |
| location detail | `GET https://mybusinessbusinessinformation.googleapis.com/v1/{location}?readMask=name,title,categories,phoneNumbers,websiteUri,regularHours,specialHours,profile,storefrontAddress,openInfo,serviceItems,metadata` |
| reviews | `GET https://mybusiness.googleapis.com/v4/{account}/{location}/reviews?pageSize=50&pageToken=` |
| reply | `PUT https://mybusiness.googleapis.com/v4/{reviewName}/reply` body `{ comment }` |
| delete reply | `DELETE https://mybusiness.googleapis.com/v4/{reviewName}/reply` |
| local post | `POST https://mybusiness.googleapis.com/v4/{account}/{location}/localPosts` |
| metrics | `GET https://businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries` |

Rules inside the adapter:

- Every call: 15 s `AbortController` timeout. Retry on 429/5xx/network error up to 3
  times with backoff 1 s → 3 s → 9 s plus jitter. Honour `Retry-After`. **No retry** on
  400/401/403/404.
- Throw a typed error: `{ code: 'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'UPSTREAM' | 'BAD_REQUEST', status, message }`.
  `AUTH` (401, `invalid_grant`) is what makes callers set `needs_reconnect`.
- Normalize Google shapes at the boundary (`starRating: 'FOUR'` → `4`, nested
  `reviewer.displayName` → `reviewerName`, etc.) so no other file sees raw Google JSON.
- Never log tokens or full response bodies. Log `method path status ms`.

`data/integrations/google-mock.js` implements the same interface with deterministic
fixtures: one account, two locations, ~8 reviews (mix of 1–5 stars, English, Hinglish
and one Hindi, one with an existing reply, one hotel-style "room was noisy"), 28 days
of metrics, a location missing description and holiday hours (so the audit has
findings). `replyToReview` and `createLocalPost` mutate in-memory state so the UI
round-trips. Reviewer names must be obviously fake (e.g. `"Demo Reviewer A"`).

`data/integrations/index.js` exports `getGoogleAdapter()`:
- `GOOGLE_MODE=mock` + not production (S7) → mock
- `GOOGLE_MODE=live` + client id/secret + `secrets.isConfigured()` → live
- otherwise `null`. Every route returns `503 { code: 'GOOGLE_NOT_CONFIGURED' }`.

Expose `getGoogleAdapter` on `routeCtx`.

**Verify:** a `node -e` script against the mock exercises every method. Check the
live adapter's `getAuthUrl` output shape by eye (scope, redirect, offline, consent).

## GB4 — Connect / pick location / disconnect

New route module `data/routes/google.js`, mounted after `wa-qr` at `data/server.js:2479`.
Owner/manager/admin only on every mutating route. **Confirm the actual staff role
strings** (`grep -rn "role" data/routes/auth.js data/auth.js`) and use
`requireRole(...)` with them. Do not guess.

| Route | Auth | Does |
|---|---|---|
| `GET /api/businesses/:id/google/status` | auth + branch | `{ configured, mode, status, googleEmail, locationTitle, mapsUri, lastSyncAt, lastSyncError }`. **No tokens** |
| `POST /api/businesses/:id/google/connect` | auth + branch + role | returns `{ url }`. `state = signToken({ purpose:'google_oauth', businessId, staffId, nonce }, '10m')` (check `signToken`'s actual signature) |
| `GET /api/google/oauth/callback` | **none** (browser redirect) | verify state + purpose. Exchange code. Encrypt and store tokens with `status='pending_location'`. Redirect to `/manager?google=pick`. On any error redirect `/manager?google=error&reason=<short code>`. Never echo Google's message into the URL |
| `GET /api/businesses/:id/google/locations` | auth + branch + role | lists all locations across accounts (title + address) |
| `POST /api/businesses/:id/google/location` | auth + branch + role | body `{ accountName, locationName }`. Verify it's in the user's list (never trust the body). Save, set `connected`, `logEvent('google.connected')`, kick an initial review sync (GB5) without awaiting it |
| `POST /api/businesses/:id/google/disconnect` | auth + branch + role | revoke (best effort), null the tokens, `status='disconnected'`, `logEvent('google.disconnected')`. Keep synced reviews for history |

Token helper in the same module: `getValidAccessToken(businessId)`. Decrypt, refresh
if expiring within 2 min, persist the new access token. On `AUTH` error: set
`needs_reconnect`, raise `opsAlerts.raiseAlert('google_auth', businessId, ...)`, throw.

Settings UI (`public/manager.html`, Settings tab): a **"Google Business Profile"** card.
- **Not configured:** "Google connection isn't available yet". No button.
- **Disconnected:** **[Connect Google]** opens the URL from `/connect` (same window).
- **`?google=pick`:** a location picker modal (radio list → Save).
- **Connected:** location title, "Last synced 10:42 AM", **[Sync now]** **[Disconnect]**.
- **`needs_reconnect`:** amber card, "Google connection needs attention · last
  successful sync …", **[Reconnect]**.
- **Mock mode:** a visible `DEMO DATA` pill on the card.

Owner-facing words only: Connect, Reconnect, Disconnect. Never "OAuth" or "token".

**Verify (mock):** connect → pick location → status `connected`. Disconnect → status
`disconnected`, tokens null in DB. Callback with a tampered state → error redirect,
no DB write. A manager of café A calling café B's `/google/status` → 403.

## GB5 — Review sync + scheduler

`syncGoogleReviews(businessId)` in `data/routes/google.js` (export it and put it on ctx):

1. Skip unless `status === 'connected'`.
2. Page through `listReviews` (stop after 20 pages as a safety cap). Upsert each review.
   If a review exists and Google's `reply_text` differs from ours, Google wins
   (reply edited outside Zordical).
3. For each **inserted** review: `logEvent('review.received', { metadata: { stars, source:'google' } })`.
   If `star_rating <= 3`, notify the owner (push + WhatsApp to `managerPhone` via
   `sendWhatsAppToCustomer`, same pattern as the review-claim manager ping at
   `data/server.js:1668-1676`): "⭐⭐ New 2-star Google review — tap to reply".
   **On the very first sync, don't notify per review**: send one summary instead
   ("Imported 143 Google reviews").
4. Queue new reviews **without a reply** for AI analysis (GB6). Don't block the sync
   on AI; process them after the upsert loop, sequentially, max 25 per run.
5. Write `last_sync_at` / `last_sync_error`. On `AUTH`, follow GB4's
   `needs_reconnect` path.

Concurrency: an in-memory `Set` of businessIds currently syncing. A second call while
one runs returns `{ skipped: 'in_progress' }`.

Scheduler in `data/server.js` next to the other intervals: every 30 min, sync all
`connected` businesses **sequentially** with 2 s between them.
`POST /api/businesses/:id/google/sync` ("Sync now") is rate-limited to 1 per 2 min per
business (use the existing `rateLimit` helper the way `marketing.js` imports it).

Re-point the legacy `POST /gbp/sync` (GB0) to `syncGoogleReviews` so the old Feedback
tab button works.

**Verify (mock):** first sync imports all fixtures and sends exactly one summary
notification. A second sync inserts 0 rows. Add a 1-star review to the mock state and
sync → exactly one owner alert. Concurrent double-call → second is skipped.

## GB6 — AI analysis + reply draft

`analyzeAndDraftReview(businessId, review)`: **one** `callClaude` call that returns JSON:

```json
{ "sentiment": "negative", "topics": ["waiting_time","service"], "draft": "..." }
```

Topic vocabulary (closed list, reject anything else):
`food_quality, taste, portion, price_value, service, staff, waiting_time, cleanliness,
ambience, music_noise, seating, wifi, parking, location, packaging, delivery, menu_variety,
coffee_beverages, room_cleanliness, room_comfort, check_in, amenities, breakfast,
hospitality, booking_issue, other`.

Prompt inputs:
- Café name, vertical (café/restaurant/hotel), `assistantName` if set.
- The café's knowledge facts (`knowledge.json`) for grounding, read the same way the
  WhatsApp prompt does.
- Review stars, text and reviewer first name.

Draft rules (put them in the prompt):
- Reply in the **review's language** (English / Hindi / Hinglish).
- 2–4 sentences, under 500 characters. Thank by first name.
- Address the specific points raised.
- **Never** promise refunds, discounts, freebies or compensation.
- **Never** state facts not in the knowledge facts.
- **Never** mention loyalty points, rewards or coupons.
- **Never** argue or blame the customer.
- For ≤3 stars: apologise once, and invite them to contact the café directly (phone
  from the business record if present).
- Empty review text (rating only): a short thank-you.
- No hashtags, no emojis beyond one at most.

Parsing: extract the first `{...}`, `JSON.parse` in try/catch, validate the fields
(drop unknown topics, clamp draft length). On `null`/parse failure: leave
`draft_status='none'` and store `sentiment` from stars only (≥4 positive, 3 neutral,
≤2 negative). The owner can still reply manually. Never invent a canned draft for
negative reviews.

`POST /api/businesses/:id/google/reviews/:reviewName/draft` regenerates
(`reviewName` is URL-encoded, since it contains slashes). Optional body
`{ tone: 'warmer' | 'shorter' | 'more_formal' }`. Rate limit 10/min per business.

**Verify (mock):** each fixture gets sensible topics. The Hinglish review gets a
Hinglish draft. The 1-star draft has no compensation promise (grep the draft for
`refund|free|discount|points|coupon`). Kill the Anthropic key locally → no crash,
`draft_status='none'`.

## GB7 — Reviews inbox + publish reply

API:
- `GET /api/businesses/:id/google/reviews?filter=needs_reply|negative|replied|all&limit=20&offset=0`
  — `needs_reply` = no `reply_text`; `negative` = `star_rating <= 3`. Newest first.
  Also return summary counts `{ total, needsReply, negativeNeedsReply, avgRating, responseRate90d }`.
- `POST .../google/reviews/:reviewName/reply` body `{ text }`. Role-gated. Trim, 1–4000
  chars. Set `draft_status='publishing'` (if already `publishing`, return 409:
  double-tap guard), call the adapter, then `reply_text`, `reply_time`, `replied_by`,
  `draft_status='published'`, `logEvent('review.replied', { metadata: { stars, aiDrafted: boolean, edited: boolean } })`.
  On failure: `draft_status='failed'`, `publish_error` = short human message; the
  owner sees a Retry.
- `DELETE .../google/reviews/:reviewName/reply`: role-gated; removes the live reply.
- `POST .../google/reviews/:reviewName/skip` → `draft_status='skipped'`.

UI: in `<div id="tab-feedback">` (`public/manager.html:754`), add a **"Google Reviews"**
section above the existing feedback list. Keep the existing WhatsApp feedback list
below it, unchanged.
- **Header:** avg rating, total, "N need a reply", and the response rate. Filter
  chips: Needs reply (default), Negative, Replied, All.
- **Card:** stars, reviewer, relative date, text, topic chips, and the AI draft in an
  editable textarea. Buttons: **Publish reply**, **Regenerate ▾** (warmer / shorter /
  more formal), **Skip**.
- **Before publishing a ≤3-star reply:** confirm dialog "This reply will be public on
  Google. Publish?".
- **Published state:** shows the reply and "Replied by Zordical · date", with
  **Edit** / **Delete reply**.
- **Mobile first:** the card must work at 375 px with no horizontal scroll, and the
  buttons wrap.
- **Load more:** a button, not infinite fetching of everything.
- **Not connected:** the section shows a single CTA: "Connect Google to manage your
  reviews here" → Settings.
- **Mock mode:** `DEMO DATA` pill.

Replace `syncGBP()`'s button label with **"🔄 Sync now"** and wire it to the new
`/google/sync` route.

Push/notification taps from GB5 deep-link to `/manager?tab=feedback&filter=negative`.
Add the param handling if `showTab` doesn't already read the query string.

**Verify (mock, in the browser at desktop and 375 px):**
- Publish a reply → the card moves to Replied, and a re-sync keeps it.
- Edit, then delete.
- Double-click Publish → one adapter call.
- Force an adapter failure → Failed state + Retry works.
- `staff` role (if it exists) → 403 on publish.
- Screenshot both widths.

## GB8 — Profile health audit

`runGoogleAudit(businessId)` builds findings from `getLocation` + DB review stats.
**Deterministic rules, no AI**, so the score is explainable and stable.

Each finding is `{ id, area, severity: 'critical'|'needs_attention'|'good', points, title, why, fix, fixUrl }`.

Rules (points sum to 100):

| Area | Check | Pts | Severity if failing |
|---|---|---|---|
| Basics | title present | 5 | critical |
| Basics | primary category set | 10 | critical |
| Basics | phone present | 8 | critical |
| Basics | address present | 7 | critical |
| Basics | website present | 5 | needs_attention |
| Hours | regular hours set | 10 | critical |
| Hours | special/holiday hours set for any date in the next 60 days (Diwali, Christmas, New Year: list the dates in config) | 5 | needs_attention |
| Description | ≥ 250 chars | 8 | needs_attention |
| Description | mentions city/area name | 2 | needs_attention |
| Categories | ≥ 1 additional category | 5 | needs_attention |
| Menu/Services | serviceItems present | 5 | needs_attention |
| Reviews | response rate ≥ 80% (last 90 days) | 10 | needs_attention (<50% → critical) |
| Reviews | no unanswered ≤3★ older than 48 h | 10 | critical |
| Reviews | median reply time ≤ 48 h (last 90 days, Zordical-published only) | 5 | needs_attention |
| Status | `openInfo.status === 'OPEN'` | 5 | critical |

- A field the API doesn't return is reported as `"Couldn't check"` with 0 points
  either way. It is excluded from the denominator, never counted as missing.
- Score = earned ÷ checkable × 100, rounded.
- `fixUrl` = `https://business.google.com/` (editing the profile via API is out of
  scope; GB8 diagnoses, the owner fixes in Google).
- Store each run in `google_audits`. Run on connect, weekly in the scheduler, and on
  `POST .../google/audit` (rate limit 1 per 5 min).

UI: a **"Google profile health"** panel at the top of the Feedback tab or a sub-tab
(implementer's choice, mobile-first).
- The score, with the label **"Zordical profile health: our checklist, not a Google
  ranking"**.
- Grouped findings, critical first, each with *why* + **[Fix on Google]**.
- The trend versus the previous audit.
- **No copy may claim a fix improves ranking.** Use "helps customers find and choose
  you" phrasing.

**Verify (mock):** the fixture missing description and holiday hours produces exactly
those findings. Reply to all mock negatives → the Reviews findings flip to good on
re-run. The score matches a hand calculation.

## GB9 — Google posts (draft → approve → publish/schedule)

API (role-gated):
- `POST .../google/posts/generate` body `{ topicType, goal, offerText?, startDate?, endDate?, language }`.
  `callClaude` drafts `summary` (≤1500 chars; aim for 300–600), a `title` for
  OFFER/EVENT, and a suggested CTA, grounded in knowledge facts + menu items. The
  prompt forbids prices, discounts or dates not supplied in the request or present
  in the facts.
- `POST .../google/posts` creates a `draft` (manual or from generate). `PUT` edits a draft.
- `POST .../google/posts/:postId/approve` body `{ scheduledFor? }`: no date →
  publish now; date in the future → `scheduled`. Sets `approved_by`.
- `POST .../google/posts/:postId/reject`, `DELETE` (drafts only).
- `GET .../google/posts?status=` (paginated).

Publishing (`publishGooglePost(postId)`):
- Atomic claim: `UPDATE google_posts SET status='publishing', updated_at=datetime('now') WHERE id=? AND status IN ('draft','scheduled')`
  (the approve route sets `approved_by` in the same transaction before calling this;
  the scheduler only ever passes `scheduled` rows). Only proceed if `changes === 1`,
  so a double-publish is impossible.
- Call the adapter, then `published` + `google_post_name`. `logEvent('google.post_published')`.
- On failure: `attempts++`. While under 3 → back to `scheduled` with
  `scheduled_for = now + 5 min × attempts`. On the 3rd failure → `failed`, notify the
  owner ("Your Google post couldn't be published — tap to retry").
- **Never silently drop a post.**

Images: Google needs a publicly reachable HTTPS URL. Allow `image_url` only if it
starts with `https://`. In live mode, if a café-uploaded menu photo is served from
`BASE_URL` over https, it can be used. Otherwise the post publishes text-only. No
image hosting work in this guide.

Scheduler: every 5 min, publish `scheduled` posts with `scheduled_for <= now`,
sequentially, 1 s apart.

UI: a **"Google Posts"** sub-panel (Campaigns tab or Feedback tab; pick one and note
it in the commit).
- **Composer:** type (Update / Offer / Event), goal, offer text, dates, language
  (English / Hindi / Hinglish), and **✨ Write with AI**.
- **Preview:** a card that looks roughly like a Google post.
- **Actions:** **Publish now** / **Schedule**.
- **List:** Drafts / Scheduled / Published / Failed (with Retry).

**Verify (mock):**
- Generate → edit → schedule 2 min ahead → the scheduler publishes it once.
- Force 3 adapter failures → `failed` + owner notification.
- Two simultaneous approve calls → one publish.
- The AI draft for an Update with no offer contains no `₹` or `%` (spot-check, and
  state the result).

## GB10 — Google insights next to real orders

- Nightly at 03:30 server time (same ms-until-target-hour pattern as the jobs near
  `data/server.js:3316`): for each connected business, fetch the last 35 days of
  `BUSINESS_IMPRESSIONS_DESKTOP_MAPS, BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, BUSINESS_IMPRESSIONS_MOBILE_MAPS, BUSINESS_IMPRESSIONS_MOBILE_SEARCH, CALL_CLICKS, WEBSITE_CLICKS, BUSINESS_DIRECTION_REQUESTS, BUSINESS_BOOKINGS, BUSINESS_FOOD_ORDERS`
  and upsert them into `google_daily_metrics` (re-fetching overlapping days is
  intentional: Google revises recent days).
- `GET .../google/insights?days=28` → per-day series plus totals for: views (sum of the
  4 impression metrics), calls, website clicks, direction requests, and Google
  bookings/food orders. Alongside these, **Zordical's own** orders count + revenue per
  day from the `orders` table (exclude `cancelled`), so the owner sees Google activity
  and real sales on one screen.
- UI: an Overview-tab card "From Google, last 28 days":
  - Four big numbers with change vs the previous 28 days.
  - One small line chart of Google views vs Zordical orders.
  - Footnote: "Google numbers arrive with a delay of a few days."
  - **No causal claims** ("Google drove X sales"). Attribution is Phase C.
- Missing days are gaps, not zeros. If no metrics exist yet: "Google insights will
  appear after the first nightly sync".

**Verify (mock):** 28-day totals equal the sum of the fixtures. The orders series
matches a direct SQL count for the test café. The chart renders at 375 px.

---

## §3 — Final verification (mock mode, then live)

**Mock end-to-end** (fresh local test café; leave it in place afterwards, per the
operator's standing preference):

1. Connect, pick a location.
2. Reviews import, with one summary notification.
3. Drafts are generated.
4. Publish one reply, edit it, delete it.
5. Add a mock 1★ → owner alert → reply.
6. The audit score is reasonable and flips after replying.
7. Generate + schedule a post → it publishes.
8. Insights card renders.
9. Disconnect → the cards show the connect CTA. History is retained.
10. Every API response is grep-clean of `access_token|refresh_token|ya29\.`.
11. The WhatsApp review-reward flow still works exactly as before: 5★ feedback →
    `GOOGLE_REVIEW_PENDING` → "Done" → name → claim appears in the Loyalty tab.
    (S5 regression check.)

**Live acceptance** (after Google approves API access; operator present): connect the
operator's real test profile, sync, publish **one** real reply to a real review chosen
by the operator, and publish **one** Update post. Then confirm both on Google Maps.

## §4 — Out of scope (do not build here)

- Any change to the WhatsApp Google-review reward flow (operator decision).
- Auto-replying to reviews, at any star rating.
- Editing profile fields, hours, photos or attributes via the API (GB8 links to Google).
- Photo/media upload and image hosting.
- Multi-location dashboards: one Google location per Zordical business.
- Competitor comparison (Phase D+).
- Instagram/Facebook (Phase B guide), attribution and owner daily briefing
  (Phase C guide).
- Hotel room/booking features (separate hotel guide).
- Running `remove_fake_gbp_reviews.js --apply` on any server. The operator does it.
