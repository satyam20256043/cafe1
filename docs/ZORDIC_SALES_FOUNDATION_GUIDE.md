# Sales Rep Foundation — Build Guide (SF0–SF4)

**For: a Claude Haiku session.** Every fact below was verified against the actual
code on 2026-08-03. Anchors are quoted verbatim — if one does not match, **STOP
and report** rather than guessing (line numbers drift, quoted strings do not).

**This guide builds the FOUNDATION ONLY** — the data model and attribution chain
that makes commission numbers real. The `/sales` dashboard UI is a separate,
later package. Do not build UI beyond what SF4 specifies.

Repo: `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`, branch `master`.
Work in `data/` (root `server.js` is a frozen legacy monolith — never edit it).

---

## §0 — What this is and why it exists

The operator is hiring salespeople. They get their own dashboard (later package)
showing their leads and their commission. Commission model, decided by the user:

- **10%** of the first payment a café makes (new client landed)
- **5%** of every subsequent payment (retention)
- **The 5% is uncapped** — it continues for as long as that café keeps paying for
  a plan, with no month limit. (User decision, 2026-08-03. Settled — do not add
  a cap, and do not ask about one.)
- Trigger: the café actually pays, which happens after the 30-day trial

**The blocker this package solves:** the system currently has *no record of
payments*. `subscriptionStatus` is a plain string on the business record
(`trial`/`active`/`paused`/`cancelled`) that the operator flips by hand in HQ.
There is no amount, no payment date, no history. Platform-level Razorpay billing
(`data/routes/billing.js`) is inert — its client is never constructed, so it
503s; payment is collected out-of-band today.

Commission computed off a mutable status string would be wrong in ways that cost
real employees real money: no date means you can't tell first-payment from
fifth; no stored amount means changing `plans.json` prices silently rewrites past
earnings; a café going `active → paused → active` could double-pay or lose a
commission with no audit trail.

So: build a payments ledger, freeze commission on the row at write time, and
link rep → lead → café → payment so attribution actually resolves.

---

## §1 — Verified facts (anchors)

1. **`crm_leads` table** — `data/db.js:247`, inside the big `db.exec(\`...\`)`
   schema block. Columns: `id, cafe_name, phone, owner_name, location, status,
   follow_up_date, notes, created_at, updated_at`. **No assignment column.**
2. **`migrateColumns()`** — `data/db.js:323`, an IIFE that runs *after* the main
   schema block closes (line 320). It ALTERs in missing columns for pre-existing
   DBs, swallowing errors. Pattern: `['table', 'column', 'DEF']`.
   ⚠️ **Known past bug (do not repeat):** a column added ONLY via
   `migrateColumns` for a table that doesn't exist yet is silently a no-op on
   fresh installs. **Always add a new column in BOTH places** — the
   `CREATE TABLE` in the schema block (for new DBs) *and* the `migrateColumns`
   list (for existing DBs).
3. **Lead helpers** — `data/db.js`: `createLead` (1395), `listLeads` (1404),
   `LEAD_EDITABLE_FIELDS` whitelist (1409), `updateLead` (1413), `deleteLead`
   (1430). `updateLead` only writes fields present in the `LEAD_EDITABLE_FIELDS`
   map — a new column is NOT editable until added there.
4. **Lead routes** — `data/routes/leads.js`, every endpoint guarded
   `requireAuth, requireRole('agency_admin', 'admin')`. Endpoints:
   `GET/POST /api/crm-leads`, `PUT/DELETE /api/crm-leads/:id`,
   `POST /api/crm-leads/import`, `GET/POST /api/lead-statuses`,
   `DELETE /api/lead-statuses/:label`.
5. **Agency-wide login** — `data/db.js:570` `getAdminStaffByUsername()`:
   ```
   SELECT * FROM staff WHERE username=? AND role IN ('agency_admin','admin') LIMIT 1
   ```
   This is what `/admin-login` uses. Café staff log in matched to their own
   `business_id`; agency-level roles match by username alone. **A `sales` role
   must be added to this IN-list or reps cannot log in at all.**
6. **Café-staff role whitelist** — `data/auth.js:166`:
   `const validRoles = ['owner', 'manager', 'waiter', 'cashier'];`
   This is the *per-café* staff-creation endpoint. Sales reps are agency-level,
   **not** café staff — do not add `sales` here.
7. **`requireRole`** — `data/auth.js:60`, plain `roles.includes(req.staff.role)`.
   `req.staff` is `{ id, businessId, name, role }` (auth.js:55).
8. **Manual activation endpoint** — `data/routes/business.js:368`
   `POST /api/agency/clients/:id/status`, `requireRole('agency_admin','admin')`.
   Sets `subscriptionStatus` and syncs BOTH `subscriptionPlan` and `plan`
   (writing only one broke premium AI once — keep both in sync). Persists by
   rewriting `businesses.json` wholesale.
9. **Plan prices** — `data/plans.json`: `starter` 1500, `growth` 3000, `pro` 5000
   (integers, rupees, `duration_days: 30`).
10. **Business records live in `data/businesses.json`**, loaded into an in-memory
    `businesses` array at boot — NOT in a SQLite table with a plan column. Adding
    a field means writing the JSON and restarting.
11. **`toIsoZ(sqliteTs)`** — `data/server.js`, exposed on `routeCtx`. SQLite
    timestamps have no zone marker; browsers parse them as local time (5.5h wrong
    in IST). **Every new endpoint returning a SQLite timestamp must pass it
    through `toIsoZ` before `res.json`.** This was fixed platform-wide on
    2026-08-02 — do not regress it.
12. **`routeCtx`** — `data/server.js:2342`, the shared object every route module
    destructures. Add anything new route modules need there.
13. Money columns elsewhere use `REAL` (e.g. `orders.total`). Match that.
14. **HQ already has a Staff panel** — `public/hq.html` ~348-354: `loadStaffPanel()`,
    `renderStaffTable()`, and a working inline **"🔑 Change Password"** form
    (`showPwForm`/`savePw`) that PUTs to `/api/admin/staff/:id/password`
    (`data/routes/auth.js:164`, admin-guarded, works for any staff id).
    **Password reset for reps therefore already exists** — it only needs the rep
    to be visible in the list, plus a role label. `ROLE_LABELS` is at
    `public/hq.html:349` and has no `sales` entry.
15. ⚠️ **`/api/admin/staff` will not show sales reps as written.**
    `data/routes/auth.js:156` builds the list as
    `businesses.flatMap(b => db.listStaff(b.id))` and `db.listStaff` is
    `SELECT * FROM staff WHERE business_id=?` — so it only ever returns staff
    attached to a real café. An agency-level rep is invisible to it. SF0 fixes
    this.
16. **JWT auth** — `data/auth.js:29` `signToken(payload)` →
    `jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES })`. `requireAuth`
    (auth.js:42) puts the decoded payload on `req.staff`, and `requireRole`
    (auth.js:60) checks `req.staff.role`. Any extra claim signed into the token
    is therefore visible to every route as `req.staff.<claim>` — that is the
    mechanism SF6 uses.

## §2 — STOP RULES

- **S1 — Money code.** This computes what employees get paid. If any anchor
  doesn't match, or a rule here is ambiguous, **stop and report** — do not
  improvise a formula.
- **S2 — Never recompute a past commission.** Rate and amount are frozen onto the
  payment row when it is written. Reads must never recalculate from current
  `plans.json` prices or current rates.
- **S3 — Tenant isolation.** A `sales` rep must NEVER reach café customer data,
  chat history, revenue, billing controls, or another rep's leads. Enforce
  **server-side**; a UI-only filter is not a control.
- **S4 — No destructive writes.** This package only ADDS tables/columns/routes.
  No DELETE, no UPDATE of existing rows beyond the specified backfill, no
  `businesses.json` rewrites except through the existing endpoint pattern.
- **S5 — Don't build the dashboard.** SF0–SF6 only. No `/sales` page, no rep UI
  beyond the HQ controls specified in SF4–SF6.
- **S8 — Impersonation is one-directional and narrow (SF6).** An admin may
  impersonate a `sales` rep and nothing else. The endpoint MUST refuse any
  target whose role is not exactly `sales` — allowing an admin to mint a token
  for another admin/agency_admin turns a convenience feature into a privilege
  escalation path. Every impersonation must be event-logged with both identities.
  If you cannot satisfy all three (role check, `impersonatedBy` claim, audit
  log), **stop and report** rather than shipping a partial version.
- **S6 — Test data.** Leave test cafés in place (standing user instruction).
  Stage only source files — never commit `data/businesses.json` or `data/z*/`.
- **S7 — Verify before claiming.** `node -c` every touched file, and run the
  stated check for each package. Report honestly what passed vs. what you
  couldn't test.

---

## SF0 — `sales` role

**Goal:** a sales rep can log in at `/admin-login` and is recognised as `sales`.

1. `data/db.js:570` — extend the role IN-list verbatim:
   ```js
   SELECT * FROM staff WHERE username=? AND role IN ('agency_admin','admin','sales') LIMIT 1
   ```
2. Do **not** touch `validRoles` in `data/auth.js:166` (that's café staff).
3. Sales reps are created by the operator, not self-service. Add
   `POST /api/admin/sales-reps` in `data/routes/leads.js` (it already owns
   agency-level sales concerns), guarded
   `requireAuth, requireRole('agency_admin','admin')`:
   - body `{ name, username, password, phone }`
   - hash with `bcryptjs.hashSync(password, 10)` (same as auth.js:173)
   - create via `db.createStaff({ ... role: 'sales' })`
   - **`business_id`**: agency-level staff still need one (the column is part of
     `UNIQUE(business_id, username)`). **Before writing this, run the check below
     to see what existing agency_admin rows use, and mirror it exactly.**
   - never return `password_hash`
4. Add `GET /api/admin/sales-reps` (same guard) listing `sales` staff, minus
   password hashes — SF3/SF4 need it for the rep dropdown.
5. **Fix `/api/admin/staff` so reps are visible** (`data/routes/auth.js:154`).
   As written it returns only `businesses.flatMap(b => db.listStaff(b.id))`, so
   an agency-level rep never appears — and the existing HQ password-change UI
   consequently can't reach them. Union in agency-level staff, e.g. add a
   `db.listAgencyStaff()` returning
   `SELECT * FROM staff WHERE role IN ('agency_admin','admin','sales')` and
   merge, de-duplicating by `id`. Keep stripping `password_hash`.

**Check (run first, it determines step 3):**
```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -e "const db=require('./data/db.js');console.log(JSON.stringify(db.raw().prepare(\"SELECT id,business_id,username,role FROM staff WHERE role IN ('agency_admin','admin')\").all(),null,2))"
```
If that returns zero rows, **stop and report** — you cannot infer the convention.

---

## SF1 — `crm_leads.assigned_to`

**Goal:** leads have an owner; reps see only their own.

1. Add `assigned_to TEXT` to the `crm_leads` `CREATE TABLE` at `data/db.js:247`.
2. Add `['crm_leads', 'assigned_to', 'TEXT']` to the `migrateColumns` list
   (~`data/db.js:324`). **Both places — see §1 fact 2.**
3. `LEAD_EDITABLE_FIELDS` (`data/db.js:1409`) — add `assignedTo: 'assigned_to'`.
4. `createLead` (`data/db.js:1395`) — accept `assignedTo`, default `null`.
   Update `insertLeadStmt` column list and placeholders to match.
5. `listLeads()` (`data/db.js:1404`) — accept an optional `assignedTo` filter:
   when provided, `WHERE assigned_to = ?`; when omitted, return all (admin view).
6. `data/routes/leads.js` — widen guards to admin-**or**-sales and scope by role:
   - `requireRole('agency_admin','admin','sales')` on
     `GET/POST /api/crm-leads` and `PUT/DELETE /api/crm-leads/:id`
   - **`GET`**: if `req.staff.role === 'sales'`, call
     `db.listLeads({ assignedTo: req.staff.id })`; otherwise unfiltered.
   - **`POST`**: if `sales`, force `assignedTo = req.staff.id` — a rep may not
     assign a lead to anyone else. Admins may pass `assigned_to` explicitly.
   - **`PUT`/`DELETE`**: if `sales`, load the lead first and **404 if
     `assigned_to !== req.staff.id`** (404, not 403 — don't leak existence).
     A rep must not be able to reassign a lead away from themselves: if `sales`,
     strip `assigned_to` from the update payload.
   - Leave `/api/crm-leads/import` and all `/api/lead-statuses` routes
     **admin-only** (unchanged).
7. Existing leads keep `assigned_to = NULL` (operator's own pipeline). Do not
   backfill them to anyone.

**Check:**
```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -c data/db.js && node -c data/routes/leads.js && node -e "const db=require('./data/db.js');const r=db.raw().prepare('PRAGMA table_info(crm_leads)').all().map(c=>c.name);console.log('assigned_to present:', r.includes('assigned_to'), r.join(','))"
```

---

## SF2 — Rep attribution on conversion

**Goal:** when a rep's lead becomes a real café, the link survives permanently —
otherwise a payment can never find the rep who earned it.

1. When a business is created from a lead, stamp `salesRepId` (and
   `salesLeadId`) onto the business record in `data/businesses.json`.
2. The existing convert flow opens `/onboard` and flips the lead status; onboard
   itself doesn't know about leads. Add an explicit link step:
   `POST /api/crm-leads/:id/link-business` body `{ businessId }`, guarded
   `requireRole('agency_admin','admin','sales')`, sales scoped to own lead (same
   404 rule as SF1):
   - find the business in the in-memory `businesses` array; 404 if absent
   - set `businesses[idx].salesRepId = <lead.assigned_to>` and
     `businesses[idx].salesLeadId = lead.id`
   - **refuse to overwrite** an existing `salesRepId` — return 409. Reassignment
     is an admin-only concern and out of scope here.
   - persist with `fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2))`
     — mirror `data/routes/business.js:396` exactly.
3. `businesses` and `BUSINESSES_FILE` come from `routeCtx`; add them to
   `leads.js`'s destructure if missing.

**Check:** create a throwaway lead + business locally, call the endpoint, confirm
`salesRepId` lands in `businesses.json` and a second call returns 409.

---

## SF3 — Payments ledger (the core)

**Goal:** one immutable row per payment received, carrying its own frozen
commission.

1. New table, in the main schema block near `crm_leads` (`data/db.js` ~247):
   ```sql
   CREATE TABLE IF NOT EXISTS payments (
     id            TEXT PRIMARY KEY,
     business_id   TEXT NOT NULL,
     amount        REAL NOT NULL,          -- rupees actually received
     plan          TEXT,                   -- plan id at time of payment
     paid_at       DATETIME NOT NULL,      -- when money changed hands
     recorded_by   TEXT,                   -- staff id who logged it
     reference     TEXT,                   -- UPI ref / cheque no / note
     sales_rep_id  TEXT,                   -- frozen: who earns on this
     commission_rate REAL,                 -- frozen: 0.10 or 0.05
     commission_amount REAL,               -- frozen: amount * rate
     is_first_payment INTEGER DEFAULT 0,   -- frozen: drove the rate
     created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
   );
   CREATE INDEX IF NOT EXISTS idx_payments_business ON payments(business_id);
   CREATE INDEX IF NOT EXISTS idx_payments_rep ON payments(sales_rep_id);
   ```
2. `db.recordPayment({ businessId, amount, plan, paidAt, recordedBy, reference, salesRepId })`:
   - `isFirst` = **zero existing rows** for that `business_id`
     (`SELECT COUNT(*) FROM payments WHERE business_id=?`)
   - `rate` = `isFirst ? 0.10 : 0.05`
   - `commissionAmount` = `Math.round(amount * rate * 100) / 100`
   - **if `salesRepId` is null/absent, still write the payment** with null rep,
     null rate, 0 commission — a café signed with no rep is normal (direct
     signup) and must not be blocked or silently attributed.
   - insert and return the row
   - **Never** update commission fields on an existing row.
3. Reads (all must run timestamps through `toIsoZ` at the route layer — §1.11):
   - `db.listPaymentsForBusiness(businessId)`
   - `db.listPaymentsForRep(salesRepId, { from, to })`
   - `db.getRepCommissionSummary(salesRepId)` → totals: lifetime commission,
     count of first-payments vs repeats, and this-calendar-month commission.
     Sum the **stored** `commission_amount`; never recompute.
4. Export all of these from `db.js` (`Object.assign(module.exports, {...})`,
   matching the file's existing pattern).

**Check — exercise the rate logic directly:**
```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -e "
const db=require('./data/db.js');const b='__paytest__';
const p1=db.recordPayment({businessId:b,amount:3000,plan:'growth',paidAt:'2026-08-03 10:00:00',recordedBy:'x',salesRepId:'rep1'});
const p2=db.recordPayment({businessId:b,amount:3000,plan:'growth',paidAt:'2026-09-03 10:00:00',recordedBy:'x',salesRepId:'rep1'});
console.log('1st:',p1.is_first_payment,p1.commission_rate,p1.commission_amount,'(expect 1, 0.1, 300)');
console.log('2nd:',p2.is_first_payment,p2.commission_rate,p2.commission_amount,'(expect 0, 0.05, 150)');
console.log('summary:',JSON.stringify(db.getRepCommissionSummary('rep1')));
db.raw().prepare('DELETE FROM payments WHERE business_id=?').run(b);console.log('cleaned');
"
```
Expected: 10% then 5%. If not, **stop and report** — do not adjust the test to
match the code.

---

## SF4 — "Record Payment" in HQ

**Goal:** the operator logs a real payment; commission follows automatically.

1. `POST /api/agency/clients/:id/payments`, `requireRole('agency_admin','admin')`
   — **admin-only; reps never record their own payments.** Put it in
   `data/routes/business.js` beside the existing status endpoint (line 368).
   - body `{ amount, plan, paidAt, reference }`
   - validate `amount` is a finite number `> 0` → else 400
   - validate `plan` against `plans.json` ids (reuse the read at
     `data/routes/business.js:377`) → else 400
   - `paidAt` defaults to now if absent
   - resolve `salesRepId` from the business record's `salesRepId` (SF2)
   - call `db.recordPayment({ ..., recordedBy: req.staff.id })`
   - `db.logEvent(id, 'payment.recorded', { actor: 'staff:'+req.staff.id, metadata: { amount, plan, commission: row.commission_amount } })`
   - return the created row with `paid_at`/`created_at` via `toIsoZ`
2. `GET /api/agency/clients/:id/payments` (same guard) — that café's history.
3. **Recording a payment does not by itself activate the café.** Keep the
   existing status endpoint as the activation switch. In `hq.html`, after a
   successful payment record, prompt the operator to set the café `active` if it
   isn't already — but do not flip it automatically (silent state changes to
   tenant billing are exactly what S4 forbids).
4. `hq.html` — add a "Record Payment" action in the Billing tab row for each
   café: small form (amount, plan, date, reference), posts to the endpoint, then
   refreshes that row. Match the existing Billing tab's styling and fetch
   patterns; do not restyle anything else.

**Check:** local test café → record ₹3000 growth → confirm 200, a `payments` row
with `commission_rate 0.1`, and `payment.recorded` in the events log. Record a
second → confirm `0.05`.

---

## SF5 — Admin: rep performance view

**Goal:** the operator sees how every rep is doing, in HQ.

1. `GET /api/admin/sales-performance`, `requireAuth, requireRole('agency_admin','admin')`.
   Add to `data/routes/leads.js`. Returns one row per `sales` rep:
   - `repId`, `name`, `username`
   - `leadsTotal`, and a per-status breakdown (group `crm_leads` by `status`
     where `assigned_to = repId` — statuses are user-editable, so derive them
     from the data, never hard-code a list)
   - `followUpsOverdue` — count where `follow_up_date < today` and the lead
     isn't in a closed/converted state
   - `cafesSigned` — count of businesses whose `salesRepId` is this rep (from
     the in-memory `businesses` array, not SQL)
   - `payingCafes` — distinct `business_id` count in `payments` for this rep
   - `revenueDriven` — SUM of `payments.amount` for this rep
   - `commissionLifetime`, `commissionThisMonth` — SUM of the **stored**
     `commission_amount` (S2: never recompute)
   - `conversionRate` — `cafesSigned / leadsTotal`, guarded against divide-by-zero
     (return `null`, not `NaN`/`Infinity`, when `leadsTotal` is 0)
2. Add `db.getSalesPerformance()` doing the SQL side; resolve `cafesSigned` in
   the route where `businesses` is in scope.
3. `public/hq.html` — new "Sales" panel/tab with a table of the above, sorted by
   `commissionThisMonth` descending. Match the existing HQ table markup and
   fetch patterns (see `loadStaffPanel`/`renderStaffTable`, ~348-351). Show ₹
   amounts with `toLocaleString('en-IN')`, consistent with the rest of HQ.
4. Any SQLite timestamp in the response goes through `toIsoZ` (§1.11).

**Check:** seed a rep + a lead + two payments locally, hit the endpoint, confirm
`commissionThisMonth` matches hand arithmetic and `conversionRate` is `null`
(not `NaN`) for a rep with zero leads.

---

## SF6 — Admin: password reset + log in as a rep

**Goal:** the operator can reset a rep's password and view the app as that rep.
**Read S8 before starting.**

**Password reset — mostly already built.** The HQ Staff panel's inline
"🔑 Change Password" form and `PUT /api/admin/staff/:id/password` already work
for any staff id (§1.14). Once SF0 step 5 makes reps visible in
`/api/admin/staff`, this works for them too. Only cosmetics remain:
1. `public/hq.html:349` — add `sales:'Sales Rep'` to `ROLE_LABELS`.
2. Add a `.role-sales` badge style alongside the existing `.role-*` classes.
3. Note (do not change): the minimum password length is 4 characters, enforced
   both client-side (`savePw`) and server-side (auth.js:166). That's weak for a
   new externally-held login. Flag it to the user in your report as a suggested
   follow-up; do not unilaterally change it, since it would affect every
   existing café account too.

**Impersonation — new.**
4. `POST /api/admin/sales-reps/:id/impersonate`,
   `requireAuth, requireRole('agency_admin','admin')`, in `data/routes/leads.js`:
   - load target via `db.getStaffById(req.params.id)`; 404 if absent
   - **refuse unless `target.role === 'sales'`** → 403. Not a whitelist of
     "non-admin roles" — an exact equality check on `sales` (S8).
   - `const token = signToken({ id: target.id, businessId: target.business_id, name: target.name, role: 'sales', impersonatedBy: req.staff.id })`
   - `db.logEvent(null, 'admin.impersonate', { actor: 'staff:'+req.staff.id, metadata: { targetRepId: target.id, targetName: target.name } })`
     — if `logEvent` requires a non-null business id in this codebase, use the
     activity log (`ctx.logActivity`, `data/routes/activity.js:21`) instead.
     **An impersonation that isn't recorded anywhere is not acceptable** (S8).
   - return `{ token, rep: { id, name, username } }` — never the password hash
5. **Shorter expiry.** Pass an explicit shorter `expiresIn` for impersonation
   tokens if `signToken` can accept one; if it can't without changing its
   signature, note that in your report rather than widening the helper.
6. `public/hq.html` — a "👤 Log in as" button in the rep row. On click: POST,
   stash the returned token, open `/sales` (that page doesn't exist yet — SF5/SF6
   ship before the dashboard, so it will 404 for now; that is expected and fine).
   **Do not overwrite the admin's own `cafehq_token`** — store the impersonation
   token under a separate key so the operator isn't logged out of HQ.
7. Because the claim rides on the token, `req.staff.impersonatedBy` is readable
   by every route (§1.16). Where a lead write is logged, include it so the audit
   trail shows the real actor behind a rep-attributed action.

**Check:**
```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -e "
const {verifyToken}=require('./data/auth.js');
// paste a token returned by the impersonate endpoint:
const t=process.argv[1]; if(!t){console.log('pass a token as argv');process.exit(0);}
console.log(JSON.stringify(verifyToken(t).payload,null,2));
" <TOKEN>
```
Confirm the payload has `role: 'sales'` **and** an `impersonatedBy` matching the
admin's id. Then confirm the endpoint returns **403** when pointed at an
`agency_admin` id — that negative test is the important one; run it explicitly
and report the result.

---

## §3 — Finishing

1. `node -c` every touched file.
2. Restart the local dev server; confirm a clean boot with no new errors:
   ```bash
   cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && PORT=3011 ANTHROPIC_API_KEY= node data/server.js
   ```
3. `git status` — stage **only** source files (`data/db.js`, `data/auth.js` if
   touched, `data/routes/*.js`, `public/hq.html`). Never `data/businesses.json`,
   never `data/z*/`.
4. Commit per package (SF0…SF4) or one clear commit; end the message with:
   `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`
5. Push `origin master`, then hand the user the deploy line — **do not deploy
   yourself, you have no server access:**
   ```
   cd ~/zordical && git pull origin master && pm2 restart zordical --update-env && sleep 3 && git log -1 --oneline && pm2 logs zordical --lines 15 --nostream
   ```
6. **Report honestly**: what you verified live, what you couldn't, and anything
   you skipped or that failed. Do not claim a check passed that you didn't run.

## §4 — Explicitly out of scope

The `/sales` dashboard and its sections (My Leads, Today's Follow-ups, Add Lead,
My Earnings, My Signed Cafés, Pitch Kit, Pricing Reference), commission payout
tracking (marking commission as *paid out* to a rep), clawback on refund/cancel,
a sales-manager role, and any change to café-facing UI. Those come after this
foundation is deployed and verified.

All four business decisions are settled — do not reopen them:
- 10% first payment, 5% every payment after
- 5% is **uncapped**, running as long as the café keeps paying
- reps see **only** their own leads
- admin gets a performance view, password reset, and log-in-as (SF5, SF6)
