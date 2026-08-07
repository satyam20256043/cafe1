# Owner-configurable loyalty + student discount — Build Guide (LS0–LS5)

**For: a Claude Sonnet session.** Repo `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`,
branch `master`. Work in `data/` and `public/` only — root `server.js` is frozen legacy.

---

## §0 — Why this exists

Café owners can't set their own loyalty economics, and two financial promises are
currently **hardcoded for every café on the platform**. Both are live right now on
zordic.in's 5 real cafés.

### Verified facts (read directly, 2026-08-05)

1. `data/db.js:880-883` — all four loyalty numbers are module constants:
   ```js
   const POINTS_PER_RUPEE = 1;      // 1 point per ₹1 spent
   const STAMPS_PER_VISIT = 1;
   const STAMPS_FOR_FREE  = 10;
   const POINTS_FOR_FREE  = 500;    // 500 points = ₹50 off
   ```
2. ⚠️ **`data/db.js:1008` couples earn rate to redemption value — inversely.**
   ```js
   const discount = Math.floor(pointsToRedeem / (POINTS_PER_RUPEE * 10));
   ```
   These are two independent business levers welded to one constant. An owner
   setting "2 points per ₹1" (intending generosity) silently halves each point's
   redemption value to ₹0.05 — customers get back **exactly the same rupees**.
   Decoupling these is the core of LS1. Do not preserve this coupling.
3. ⚠️ **`data/server.js:783` promises a student discount at every café:**
   ```
   - Standard offers: Students 10% off with ID 🎓 | Loyalty: earn 1 point per ₹1 spent ☕
   ```
   This string goes into the AI prompt for **every** café regardless of whether
   they offer either thing. The AI is making a financial commitment on behalf of
   businesses that never agreed to it. Both halves must become per-café.
4. `data/server.js:~769` — `"If they have 500+ points, mention they can redeem"`
   is likewise hardcoded in the personalization block.
5. **Settings home already exists**: `data/routes/extras.js:517` `loadBranchSettings()`
   / `:526` `saveBranchSettings()` over `BRANCH_SETTINGS_FILE`, exposed by
   `GET`/`PUT /api/businesses/:id/settings` (`extras.js:531`, `:545`,
   `requireAuth, requireBranchAccess`). `aiMaxDiscount` (`:538`, `:557`) is the
   exact template to copy for a new numeric setting, including its clamp:
   ```js
   Math.max(0, Math.min(100, Math.round(Number(b.aiMaxDiscount) || 0)))
   ```
6. ⚠️ **`data/db.js` has no access to `ctx`/branch settings** — it's a standalone
   SQLite module. `awardPoints`/`redeemPoints` live there. Rates must therefore be
   **passed in as optional parameters** defaulting to today's constants, so every
   existing caller keeps working untouched. Do NOT make db.js read settings files.
7. Owner decisions already settled — **do not reopen**:
   - Expiry model: **rolling inactivity** ("expires after N months of no visit"),
     not per-batch FIFO.
   - Existing balances: **grandfathered** — never retroactively destroyed.
   - Expiry default: **off** (`0` = never expires).

## §1 — STOP RULES

- **S1 — Money code.** This sets what customers are owed. If an anchor above
  doesn't match, **stop and report** — do not improvise a formula.
- **S2 — Defaults must reproduce today's behaviour exactly.** A café that never
  opens Settings must see zero change: 1 pt per ₹1, 10 pts per ₹1 redeemed, no
  expiry, no student discount claim beyond what they set.
- **S3 — Never retroactively expire.** Grandfathering is not optional (§LS3).
- **S4 — The AI must never promise what the owner didn't configure.** After LS4,
  no hardcoded discount or rate may remain in the prompt.
- **S5 — Don't touch stamps.** `STAMPS_PER_VISIT`/`STAMPS_FOR_FREE` are out of
  scope for this package.

---

## LS0 — Settings schema

Extend `branch-settings.json` (via the existing load/save helpers) with:

```js
loyalty: {
  pointsPerRupee: 1,        // earn: points awarded per ₹1 spent
  redeemPointsPerRupee: 10, // burn: points needed for ₹1 off  (10 → 500pts = ₹50, today's behaviour)
  minRedeemPoints: 0,       // 0 = no minimum
  expiryMonths: 0,          // 0 = never expire
  expiryStartedAt: null,    // ISO, set when expiry is first switched on (grandfathering — see LS3)
},
studentDiscount: {
  enabled: false,
  percent: 0,
}
```

Defaults above are exactly today's live behaviour (S2).

## LS1 — Decouple the rates in `data/db.js`

1. Keep the existing constants as the **defaults**, and add
   `const REDEEM_POINTS_PER_RUPEE = 10;` (today's implied value — derived from
   `POINTS_PER_RUPEE * 10` at db.js:1008).
2. `awardPoints(businessId, phone, name, amountSpent, orderId, opts = {})` —
   new optional trailing `opts`:
   ```js
   const rate = Number(opts.pointsPerRupee) > 0 ? Number(opts.pointsPerRupee) : POINTS_PER_RUPEE;
   const earned = Math.floor(amountSpent * rate);
   ```
3. `redeemPoints(businessId, phone, pointsToRedeem, opts = {})`:
   ```js
   const burn = Number(opts.redeemPointsPerRupee) > 0 ? Number(opts.redeemPointsPerRupee) : REDEEM_POINTS_PER_RUPEE;
   const discount = Math.floor(pointsToRedeem / burn);
   ```
   Also enforce `opts.minRedeemPoints` here (reject below threshold with a clear
   message, same `{success:false, message}` shape already returned).
4. **Every existing call site keeps working** because `opts` is optional.

## LS2 — Pass per-café rates from the callers

`data/db.js` can't read settings (§0.6), so callers pass them.

- Add `getLoyaltySettings(branchId)` in `data/server.js`, next to the existing
  `getRazorpayConfig` — same shape: read `branch-settings.json` via
  `getBranchData`, merge over the LS0 defaults, return a complete object
  (never partial). Expose it on `routeCtx`.
- Update the `awardPoints` call in `data/routes/orders.js` (order served/
  delivered path) and any `redeemPoints` call site to pass the café's settings.

## LS3 — Rolling-inactivity expiry, grandfathered

**Model**: the whole balance expires after `expiryMonths` of no visit. Any visit
resets the clock. `loyalty_points.last_visit` already exists — no new column needed.

**Grandfathering (S3)**: when expiry is switched on, record `expiryStartedAt`.
The clock start is:
```js
const clockStart = Math.max(new Date(card.last_visit), new Date(settings.expiryStartedAt));
```
so every existing customer gets a **full** `expiryMonths` window from the day the
policy turned on, rather than instantly losing a balance for past inactivity.

**Apply lazily, not on a cron** — check inside `getLoyaltyCard`-adjacent read
paths and before award/redeem. When expiring:
- zero `points` (leave stamps/visits/total_spent alone — S5)
- write a `loyalty_transactions` row with type `'expired'` and the negative
  amount, so the ledger still explains where the points went
- never expire when `expiryMonths` is `0`

## LS4 — Make the AI prompt honest

In `data/server.js`'s prompt builder:

1. Replace the hardcoded line at **:783**. Build it from settings — include the
   student clause **only** when `studentDiscount.enabled`, and use the café's real
   earn rate:
   ```
   - Standard offers: {studentClause}Loyalty: earn {pointsPerRupee} point(s) per ₹1 spent ☕
   ```
   When nothing is configured, the line should carry the loyalty rate only.
2. Replace the hardcoded `500+ points` threshold (~:769) with the café's real
   redemption minimum (`minRedeemPoints`, or the points needed for a meaningful
   discount if that's 0).
3. If `expiryMonths > 0`, give the AI the customer's expiry date so it can answer
   "when do my points expire?" — it currently cannot.

## LS5 — Manager Settings UI

In `public/manager.html`'s Settings tab, a "Loyalty & Discounts" panel:
- Earn rate, redemption rate, minimum redemption, expiry months, student
  discount toggle + percent.
- **Show the computed economics live** — e.g. *"Customers earn ₹X back per ₹100
  spent (Y%)"*. This is the number the owner actually cares about and it makes
  the earn/burn distinction self-explanatory.
- Warn plainly when expiry is switched on for the first time: existing customers
  get a full window from today, nobody loses points retroactively.
- Reuse the existing settings `fetch` pattern (`loadAiDiscount`/`saveSettings`)
  and the `.panel`/`.form-input` styling already in that tab.

---

## §2 — Verification

1. `node -c` every touched `.js`.
2. **Defaults reproduce today exactly** (S2) — on a café with no loyalty settings
   saved: ₹100 order still earns 100 pts; redeeming 500 pts still gives ₹50.
   This is the single most important check.
3. Set `pointsPerRupee: 2` and confirm redemption value is **unchanged** — this
   is the specific bug from §0.2 being fixed.
4. `minRedeemPoints` blocks a below-threshold redemption with a clear message.
5. Expiry: set `expiryMonths: 1` on a test café with an old `last_visit`, confirm
   the balance **survives** (grandfathered from `expiryStartedAt`), and that an
   `expired` transaction row appears only once the new window actually lapses.
6. Prompt: confirm a café with `studentDiscount.enabled: false` produces a prompt
   containing **no** student-discount promise; enable it at 15% and confirm the
   prompt says 15%.
7. Leave test cafés in place. Stage only source files — never `data/businesses.json`,
   never `data/z*/`.

## §3 — Out of scope

Per-batch/FIFO expiry, tier-threshold scaling (`loyaltyTier()` at db.js:885 stays
absolute — flag to the operator that a very generous earn rate makes everyone
Elite quickly), stamps, expiry-warning WhatsApp campaigns (a strong follow-up:
the re-engagement sweep already exists and "your 340 points expire in 7 days" is
a good visit driver), and applying the student discount to actual order totals —
for now it remains a statement the AI makes, matching current behaviour.
