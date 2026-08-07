# Delivery orders — approval gate, owner-set fee, end-to-end tracking (DL0–DL7)

**For: a Claude Sonnet session.** Repo `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`,
branch `master`. Work in `data/` and `public/` only — root `server.js` is frozen legacy.

Owner decisions already settled by the operator — **do not reopen**:

- Customers can place delivery orders themselves (not staff-entry only).
- Approval is an **owner-configurable toggle**, default **off**.
- **No rider/driver assignment** — status stages only.
- **The delivery fee is set by the café owner.**

---

## §0 — Why this exists

Today every order — dine-in, takeaway, delivery — goes straight to the kitchen
with no approval step, and the pipeline ends at `served`. A café running its own
delivery has no way to vet an order before the kitchen starts cooking it, and no
way to represent "the food has left the building."

### Verified facts (read directly, 2026-08-07)

1. **`order_type` already exists** — `data/db.js:675`:
   ```
   order_type    TEXT DEFAULT 'dine_in',  -- dine_in | takeaway | delivery
   ```
   There is **no** `delivery_address` and **no** `delivery_fee` column. Both are new.

2. **Every order is born `pending`, regardless of type** — `data/db.js:704`:
   ```sql
   VALUES
     (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending',datetime('now'),datetime('now'))
   ```
   There is no branch on `orderType` anywhere in `createOrder`.

3. **The valid-status list is the gate for everything** — `data/routes/orders.js:139`:
   ```js
   const validStatuses = ['pending','confirmed','preparing','ready','served','cancelled'];
   ```

4. ⚠️ **`'delivered'` is already referenced twice but is unreachable** —
   `data/routes/orders.js:176` and `:199` both test `status === 'delivered'`, yet
   `'delivered'` is not in `validStatuses` above, so those branches are dead code
   today. Line `:176` is the **loyalty-award** branch:
   ```js
   if (db && customerPhone && (status === 'served' || status === 'delivered')) {
   ```
   Adding `'delivered'` to `validStatuses` therefore **switches on loyalty awarding
   for delivery orders automatically** — that is correct and intended, but be aware
   you are activating existing code, not writing new code, and it must fire
   **exactly once** per order.

5. ⚠️ **The WhatsApp status-notify block is dead** — `data/routes/orders.js:199`:
   ```js
   if (whatsappClient && whatsappConnectionStatus === 'Connected' && customerPhone && status !== 'served' && status !== 'delivered') {
   ```
   `whatsappClient` is a legacy global that is declared and never assigned under the
   current Meta Cloud API / QR setup, so this never sends. The **working** send path
   is `sendWhatsAppToCustomer(branchId, phone, text, opts = {})` at
   `data/server.js:2765` (already on `ctx`). Same for the loyalty-notify block at `:183`.

6. ⚠️ **The kitchen fetches ALL orders and filters client-side** —
   `public/kitchen.html:261`:
   ```js
   const data = await fetch('/api/businesses/' + bizId + '/orders?limit=200', { headers: getAuthHeaders() })
   ```
   No `?status=` filter. So a new `pending_approval` status will **leak into the
   kitchen's "All" tab** unless you explicitly exclude it client-side. This is the
   single easiest way to get DL3 wrong.

7. **Kitchen status plumbing to update** — `public/kitchen.html`:
   - `:293` `function getStatus(o) { return o.status || o.order_status || 'pending'; }`
   - `:296` and `:349` both hardcode `const active = ['pending','confirmed','preparing','ready'];`
   - `:318`/`:319` the `map`/`label` objects for status pills
   - `:322-341` `actionBtns(order, orderId, status)` — the button ladder
   - `:366` `const priority = ['pending','confirmed','preparing','ready','served','cancelled'];`
   - `:189-197` the `.filter-tabs` button row

8. ⚠️ **Manager order list derives its buttons from one array** —
   `public/manager.html:3387`:
   ```js
   const statusFlow = ['pending','confirmed','preparing','ready','served','cancelled'];
   ```
   followed at `:3392` by `const idx = statusFlow.indexOf(o.status);`. Any status not
   in this array yields `idx === -1` → **no action buttons at all**. A
   `pending_approval` order would render with no way to approve it.
   Also `:3389` builds a CSS class from the raw status (`'badge-' + o.status`) and
   only `badge-pending`/`badge-served`/etc. exist (`:316-322`) — new statuses need
   new classes or they render unstyled.

9. **Settings home + the exact pattern to copy** — `data/routes/extras.js`:
   `loadBranchSettings()`/`saveBranchSettings()`, `GET` at `:531`, `PUT` at `:552`,
   both `requireAuth, requireBranchAccess`. The `loyalty`/`studentDiscount` blocks
   added in the LS package (`:568-599`) are the **exact template** for DL1, including
   server-only fields and clamping. `getLoyaltySettings(branchId)` in `data/server.js`
   (next to `getRazorpayConfig`) is the template for `getDeliverySettings`.

10. **The customer page is unauthenticated** — it cannot call `GET /settings`
    (`requireAuth`). The established pattern for handing a public page a safe subset
    of café config is `GET /api/razorpay-config/:id` — `data/routes/orders.js:333`,
    no auth, returns only non-secret fields. DL2 copies this shape.

11. **The server already recomputes money from scratch** —
    `data/routes/orders.js:49-72` refetches menu prices ("prevent tampering") and
    computes:
    ```js
    const tax   = parseFloat(((subtotal - discount) * 0.05).toFixed(2));  // 5% GST
    const total = parseFloat((subtotal - discount + tax).toFixed(2));
    ```
    The customer page's `cartTotals()` (`public/table-order.html:347`) is **display
    only** and mirrors this formula.

12. **Customer page order submission** — `public/table-order.html:375` hardcodes
    `orderType:'dine_in'` and always sends `tableNo`. Table number comes from the URL
    at `:190`: `const tableNo=params.get('table')||'1';`

13. **Customer tracking stepper** — `public/table-order.html:495-501` `const STEPS=[…]`,
    5 entries ending at `served`; `:502` `statusIndex`; `:523` the
    `order_status_update` socket handler. `emitToBranch(..., { public: true })`
    (`data/server.js:146-150`) is what reaches the customer's browser — the status
    endpoint already passes it at `orders.js:162`.

---

## §1 — STOP RULES

- **S1 — Money code.** The delivery fee changes what a customer is charged.
  If an anchor above doesn't match, **stop and report** — do not improvise.
- **S2 — The fee is SERVER-derived, never client-supplied.** Read it from the
  café's settings inside the POST handler. If the request body contains a
  `deliveryFee`, **ignore it**. Same rule as `expiryStartedAt` in the LS package:
  anything the client can set, the client can forge.
- **S3 — Defaults must reproduce today's behaviour exactly.** A café that never
  opens the new settings panel sees zero change: no delivery option, no approval
  gate, no fee, dine-in and takeaway totals byte-identical.
- **S4 — A `pending_approval` order must never reach the kitchen.** Not in the
  board, not in "All", not in the active count, no new-order sound. See §0.6.
- **S5 — Loyalty must be awarded exactly once per order.** `'delivered'` and
  `'served'` are both award triggers (§0.4); a delivery order must not be able to
  pass through both. Do not award on `pending_approval` or `out_for_delivery`.
- **S6 — Don't touch dine-in/takeaway flow.** Their pipeline stays
  `pending → confirmed → preparing → ready → served`, unchanged.

---

## DL0 — Schema: two new columns

Add to the `cols` array in `migrateColumns()` (`data/db.js:344`), in the `// Orders`
group, matching the existing `['table','column','TYPE DEFAULT x']` shape:

```js
['orders', 'delivery_address', 'TEXT'],
['orders', 'delivery_fee',     'REAL DEFAULT 0'],
```

Also add both to the `CREATE TABLE orders` block at `data/db.js:669` so fresh
databases match migrated ones. Then extend `createOrder` (`:698`) to accept and
persist `deliveryAddress` and `deliveryFee`, defaulting to `''` and `0`.

**Why a column, not a JSON blob**: `delivery_fee` has to appear in revenue reports
and the data sheet export, both of which read columns directly.

## DL1 — Owner settings

Extend `branch-settings.json` via the existing helpers with:

```js
delivery: {
  enabled: false,          // master switch — off means nothing about today changes
  requireApproval: false,  // true → delivery orders start at pending_approval
  fee: 0,                  // ₹ flat, owner-set, added AFTER tax (see DL2)
  freeAbove: 0,            // 0 = never waive; else waive the fee at/above this order value
  minOrderValue: 0,        // 0 = no minimum
  areaNote: '',            // free text shown to the customer ("We deliver within 5km")
}
```

1. Add `getDeliverySettings(branchId)` in `data/server.js` immediately after
   `getLoyaltySettings`, same contract: merge over defaults, **always return a
   complete object**, never throw. Expose it on `routeCtx`.
2. Extend `GET /api/businesses/:id/settings` (`extras.js:531`) to return
   `delivery: getDeliverySettings(req.params.id)`.
3. Extend `PUT` (`extras.js:552`) with a validated `if (b.delivery) {…}` block.
   Clamp exactly like the LS block does:
   - `fee`: `Math.max(0, Math.min(2000, Math.round(Number(...) || 0)))`
   - `freeAbove`, `minOrderValue`: `Math.max(0, Math.round(Number(...) || 0))`
   - `enabled`, `requireApproval`: `!!`
   - `areaNote`: `String(...).slice(0, 200)`

## DL2 — Public config endpoint + server-authoritative fee

**Endpoint.** Add next to `GET /api/razorpay-config/:id` (`orders.js:333`), same
no-auth shape, returning only what a customer may see:

```js
// GET /api/delivery-config/:id — public. Tells the customer ordering page whether
// this café delivers, what it charges, and its minimum. No approval/internal flags.
app.get('/api/delivery-config/:id', (req, res) => {
  const d = getDeliverySettings(req.params.id);
  res.json({
    enabled: !!d.enabled,
    fee: d.fee,
    freeAbove: d.freeAbove,
    minOrderValue: d.minOrderValue,
    areaNote: d.areaNote,
  });
});
```
Do **not** expose `requireApproval` — whether an order is vetted is the café's
internal business, not the customer's.

**Fee application** in `POST /api/businesses/:id/orders` (`orders.js:29`). Insert
after the existing `tax`/`total` lines at `:71-72`, replacing the `total` line:

```js
const tax = parseFloat(((subtotal - discount) * 0.05).toFixed(2));  // 5% GST

// S2: the fee is read from the café's own settings, never from the request body.
// Applied after tax as its own line — a service charge on the delivery, not on
// the food, so it does not shift the GST any café already reports today (S3).
let deliveryFee = 0;
if ((orderType || 'dine_in') === 'delivery') {
  const dcfg = getDeliverySettings(businessId);
  if (!dcfg.enabled) return res.status(400).json({ error: 'This café is not accepting delivery orders right now.' });
  const goods = subtotal - discount;
  if (dcfg.minOrderValue > 0 && goods < dcfg.minOrderValue) {
    return res.status(400).json({ error: `Minimum order for delivery is ₹${dcfg.minOrderValue}.` });
  }
  deliveryFee = (dcfg.freeAbove > 0 && goods >= dcfg.freeAbove) ? 0 : dcfg.fee;
}
const total = parseFloat((subtotal - discount + tax + deliveryFee).toFixed(2));
```

`minOrderValue` is enforced **here**, server-side — a client-side check alone is a
suggestion, not a rule.

**Starting status.** Still in the same handler, decide the status before
`db.createOrder`:

```js
const needsApproval = (orderType || 'dine_in') === 'delivery'
  && getDeliverySettings(businessId).requireApproval;
```
Pass it through to `createOrder` (add an optional `status` parameter defaulting to
`'pending'` — do not change the default, S3) and use `'pending_approval'` when true.

**Socket event.** A `pending_approval` order must not fire the kitchen's
`new_order`. Emit `new_order` only when the order is genuinely `pending`; emit a
separate `order_awaiting_approval` event otherwise, and have the manager page
listen for it.

## DL3 — Status pipeline

Extend `validStatuses` (`orders.js:139`) to:
```js
const validStatuses = ['pending_approval','pending','confirmed','preparing','ready','out_for_delivery','delivered','served','cancelled'];
```

**Kitchen (`public/kitchen.html`) — S4 is the hard requirement here:**
- In `loadOrders` (`:261`), after `orders = Array.isArray(data) ? data : []`, filter
  out `pending_approval` entirely. That one line satisfies S4 for the board, the
  "All" tab, the active count and the sound in one place — do it there, not in six
  places downstream.
- `active` arrays at `:296` and `:349`: add `'out_for_delivery'`.
- `priority` at `:366`: insert `'out_for_delivery'` before `'served'`, add `'delivered'`.
- `map`/`label` at `:318-319`: add `out_for_delivery` (🛵 "Out for Delivery") and
  `delivered` (📦 "Delivered"), plus matching `.sp-*` CSS.
- `actionBtns` (`:322`) becomes order-type aware:
  ```js
  const isDelivery = (order.order_type || order.orderType) === 'delivery';
  if (status === 'ready' && isDelivery) btns.push(/* 🛵 Out for Delivery → out_for_delivery */);
  if (status === 'ready' && !isDelivery) btns.push(/* existing 🎉 Served button, unchanged */);
  if (status === 'out_for_delivery')     btns.push(/* ✅ Delivered → delivered */);
  ```
  Leave the `pending`/`confirmed`/`preparing` buttons exactly as they are (S6).
- Add a "🛵 Out for Delivery" filter tab to `:189-197`.

**Manager (`public/manager.html`):**
- `statusFlow` at `:3387` — see §0.8. Do **not** simply append the new statuses to
  one flat array; that would offer a dine-in order an "Out for Delivery" button.
  Pick the flow per order:
  ```js
  const DINE_FLOW     = ['pending','confirmed','preparing','ready','served','cancelled'];
  const DELIVERY_FLOW = ['pending_approval','pending','confirmed','preparing','ready','out_for_delivery','delivered','cancelled'];
  const flow = (o.order_type === 'delivery') ? DELIVERY_FLOW : DINE_FLOW;
  ```
- Add `.badge-pending_approval`, `.badge-out_for_delivery`, `.badge-delivered` CSS
  next to `:316-322`, or those badges render unstyled.
- Add the new statuses to the `#order-filter` dropdown (`:847-855`).

**Loyalty (S5).** `orders.js:176` already awards on `'served' || 'delivered'`.
Verify no path lets one order hit both — a delivery order's ladder ends at
`delivered` and never offers `served`, and vice versa. Confirm by reading the
final `actionBtns`, and prove it in verification step 6.

## DL4 — Approval queue in the manager portal

No new tab. In the existing **Orders & Revenue** tab:

- A "🕐 Awaiting Approval" panel above the live queue, visible **only** when the
  café has `requireApproval` on and there is at least one such order. Each row
  shows customer, phone, address, items, total (with the fee broken out) and two
  buttons: **Approve** (→ `pending`) and **Reject** (→ `cancelled`).
- Approving must fire the kitchen's `new_order` socket event — the kitchen has not
  seen this order yet, so a plain status update would leave it invisible until the
  next poll.
- Also surface the count on the Overview "⚠️ Needs You" card, reusing the existing
  escalations pattern there.
- Listen for the `order_awaiting_approval` event from DL2 so a new one appears live.

## DL5 — Customer delivery ordering

Reuse `public/table-order.html` — **do not create a new page**. Entry point is
`/order/:id?mode=delivery`, read the same way `tableNo` is at `:190`.

- `const isDelivery = params.get('mode') === 'delivery';`
- On load, `GET /api/delivery-config/:id`. If `enabled` is false, show a plain
  "this café isn't taking delivery orders" message instead of the menu — never a
  half-working cart.
- Checkout form: when `isDelivery`, replace the table-number context with a
  **required** delivery address textarea and a **required** phone (today `phone` is
  optional — for delivery it is how the café reaches the customer). Keep name required.
- `cartTotals()` (`:347`) gains the fee as a separate display line, mirroring the
  server formula from DL2 exactly. Show `areaNote` and, when `minOrderValue` is not
  met, disable the place-order button with a clear "add ₹X more" message.
- `placeOrder()` (`:375`): send `orderType: isDelivery ? 'delivery' : 'dine_in'`,
  include `deliveryAddress`, and **do not send a fee** (S2). Omit `tableNo` for
  delivery.
- The existing Razorpay/cash choice needs no change — cash simply means
  pay-on-delivery. Label it accordingly when `isDelivery`.
- **Stepper** (`:495-501`): keep the 5 dine-in steps as-is (S6) and select a
  delivery variant when the order type is delivery — same shape, ending
  `Ready → 🛵 Out for Delivery → 📦 Delivered`, plus a leading `🕐 Awaiting
  Confirmation` step when the order came back as `pending_approval`.
- The socket handler at `:523` needs no structural change — it already re-renders
  from whatever status arrives.

**Where the link comes from**: add a "Delivery ordering link" row to the QR Codes
tab showing `/order/<id>?mode=delivery` with a copy button, next to the existing
table QR codes. Owners share it on Instagram/WhatsApp/their website.

## DL6 — WhatsApp status notifications, delivery-only

Both dead blocks (`orders.js:183` loyalty-notify and `:199` status-notify) are
guarded on `whatsappClient`, a legacy global that is never assigned (§0.5). The
working dispatcher is `sendWhatsAppToCustomer(branchId, phone, text)` — note it
is **not currently destructured in `orders.js`** (see `:9`), so add it. It is
already on `routeCtx` (`data/server.js:2412`) and `data/routes/marketing.js:17`
uses it successfully; that is the proven path. Pass a **bare phone** — it resolves
`@c.us`/`@lid` targeting itself — and drop the connection guards, since it
resolves per-café config and returns `false` harmlessly when none is linked.

⚠️ **Do NOT simply revive these for every order type.**

**Per-status updates (`:199`) — delivery orders only.** A dine-in customer is
sitting in the café with the live tracking stepper already open and staff about to
hand them the food; a "your order is being prepared" WhatsApp tells them nothing
they can't see. It is also not free — WhatsApp Cloud API bills **per conversation**,
so sending on every status change of every dine-in order is a real recurring cost
across every café on the platform, for no customer benefit. Gate it:

```js
const isDelivery = (order.order_type || order.orderType) === 'delivery';
if (isDelivery && customerPhone && status !== 'delivered') { … }
```

Status copy needed: `pending_approval`, `confirmed`, `preparing`, `ready`
("packed and ready — your rider is on the way shortly"), `out_for_delivery`
("🛵 Your order is on its way!"), `cancelled`.

**The served/loyalty message (`:183`) stays for ALL order types.** It is a single
message at the end of the interaction carrying the customer's updated points and
tier — a receipt and a retention nudge, not status spam. One message per completed
order is a defensible spend. Extend its trigger to fire on `delivered` as well as
`served` (both already reach this branch — §0.4), so a delivery customer gets the
same closing message.

Keep every send `.catch()`-guarded: a WhatsApp failure must never fail the status
update itself.

**Leave web push alone** (`orders.js:165-174`, `sendPushToPhone`). It stays on for
all order types: it is free, and the customer explicitly opted in from the tracking
screen (`subscribePushForOrder`, `table-order.html:377`). A dine-in customer who
pocketed their phone genuinely benefits from a "your order is ready" buzz — that is
the case where the open tracking tab isn't in front of them.

## DL7 — Manager Settings UI

A "🛵 Delivery" panel in the Settings tab, directly below the "🎁 Loyalty &
Discounts" panel added by the LS package — copy its structure, its
`loadLoyaltySettings`/`saveLoyaltySettings` fetch pattern, and its `.panel`/
`.form-input` styling.

- Master **Delivery enabled** toggle; everything else stays hidden until it's on.
- **Require manager approval** toggle, with one plain line of copy explaining that
  delivery orders wait for approval before the kitchen sees them.
- Delivery fee (₹), free-above threshold, minimum order value, delivery-area note.
- Show the customer-facing link (`/order/<id>?mode=delivery`) with a copy button
  right in the panel once enabled — the setting is useless if the owner can't find
  the link.
- Show a live worked example, the way the loyalty panel shows earn-back:
  *"A ₹300 order pays ₹15 GST + ₹40 delivery = ₹355."*

---

## §2 — Verification

Run a local server on port 3013 and use a disposable test café.

1. `node -c` every touched `.js`. Clean boot.
2. **S3 — nothing changes by default.** On a café that never opens the delivery
   panel: place a dine-in order, confirm the total matches the pre-change formula
   exactly, confirm it lands in the kitchen as `pending` as before, and confirm
   `/order/:id` (no `mode`) is visually and functionally unchanged. This is the
   single most important check.
3. **Fee is server-authoritative (S2).** With `fee: 40`, POST an order directly by
   curl with `"deliveryFee": 0` (or `-9999`) in the body — confirm the stored
   `delivery_fee` is still `40` and the total reflects it.
4. **Minimum enforced server-side.** With `minOrderValue: 300`, curl a ₹100
   delivery order — confirm HTTP 400 and no row created.
5. **`freeAbove` waiver.** With `fee: 40, freeAbove: 500`: a ₹499 order pays the
   fee, a ₹500 order does not.
6. **S4 — the approval gate actually hides the order.** With `requireApproval: true`,
   place a delivery order, then: check the kitchen board, the "All" tab, and the
   active count — the order must appear in **none** of them. Approve it from the
   manager panel and confirm it appears in the kitchen immediately (socket, without
   a manual refresh).
7. **S5 — loyalty awarded exactly once.** Walk a delivery order through to
   `delivered` and confirm exactly one `earned` row in `loyalty_transactions` for
   it. Then confirm the delivery ladder never offers `served`.
8. **Reject path.** Reject a pending-approval order → `cancelled`, no kitchen
   ticket, no points.
9. **Customer tracking end-to-end** at 375px width: place a delivery order from
   `/order/<id>?mode=delivery`, then drive it through every stage from the kitchen
   and confirm the customer stepper advances live at each one, including
   Out for Delivery and Delivered.
10. **Disabled café.** With `delivery.enabled: false`, confirm
    `/order/<id>?mode=delivery` shows the "not accepting delivery" message and that
    a curl'd delivery order is rejected 400.
11. **DL6 gating.** Drive a **dine-in** order through every status and confirm
    **no** WhatsApp status messages are sent (only the single served/loyalty
    message at the end). Then drive a delivery order through and confirm each
    status does send. Getting this backwards costs the operator money on every
    café — check it explicitly, don't assume.
12. Leave test cafés in place. Stage only source files — never `data/businesses.json`,
    never `data/z*/`.

## §3 — Out of scope

Rider/driver assignment, live GPS tracking, distance- or zone-based fee tiers
(flat fee only), delivery-radius enforcement (`areaNote` is informational text),
scheduled/future-dated delivery, per-item delivery availability, and third-party
platforms (Zomato/Swiggy orders never enter Zordical — the AI just shares those
links, unchanged).

**Flag to the operator, don't fix here**: `public/manager.html:3415` counts the
orders badge as `status==='pending'||status==='preparing'` — it silently ignores
`confirmed` and `ready` today, and will ignore the new statuses too. Pre-existing,
unrelated to delivery, worth a separate pass.
