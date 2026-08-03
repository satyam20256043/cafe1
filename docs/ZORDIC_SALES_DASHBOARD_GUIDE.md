# Sales Rep Dashboard — Build Guide (SD0–SD6)

**For: a Claude Haiku session.** Runs **after**
`docs/ZORDIC_SALES_FOUNDATION_GUIDE.md` (SF0–SF6) is built, verified and
deployed. This builds the `/sales` page reps actually use.

Repo: `C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`, branch `master`.
Work in `data/` and `public/` (root `server.js` is frozen legacy — never edit).

⚠️ **Confidence note.** Facts about *existing* code below were verified on
2026-08-03. Facts about *foundation* code (payments table, `assigned_to`,
`salesRepId`, `/api/admin/sales-performance`…) are the **specified contract**,
not verified code — they didn't exist when this was written. §0 is a hard gate
that makes you check them before building on them. Do not skip it.

---

## §0 — PRECONDITION GATE (run first, do not skip)

```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -e "
const db=require('./data/db.js');const raw=db.raw();
const t=raw.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('payments','crm_leads')\").all().map(r=>r.name);
const leadCols=raw.prepare('PRAGMA table_info(crm_leads)').all().map(c=>c.name);
const payCols=t.includes('payments')?raw.prepare('PRAGMA table_info(payments)').all().map(c=>c.name):[];
console.log('payments table:', t.includes('payments'));
console.log('crm_leads.assigned_to:', leadCols.includes('assigned_to'));
console.log('payments cols:', payCols.join(',')||'(none)');
console.log('db fns:', ['recordPayment','listPaymentsForRep','getRepCommissionSummary','getSalesPerformance'].map(f=>f+':'+(typeof db[f]==='function')).join(' '));
"
```

**Every line must be `true` / present.** If any is false, the foundation is not
finished — **STOP and report which piece is missing.** Do not build UI against
endpoints that don't exist, and do not "helpfully" implement the missing
foundation piece yourself; that guide has stop-rules and verification steps this
one doesn't.

Also confirm a `sales` staff row exists to test with:
```bash
cd "C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot" && node -e "const db=require('./data/db.js');console.log(JSON.stringify(db.raw().prepare(\"SELECT id,username,name,business_id FROM staff WHERE role='sales'\").all(),null,2))"
```
If empty, create one via the SF0 endpoint before proceeding.

---

## §1 — Verified facts (existing code, 2026-08-03)

1. **Pages are served as plain sendFile routes** — `data/server.js:160-215`, e.g.
   ```js
   app.get('/hq', (req, res) => {
     res.sendFile(path.join(ROOT_DIR, 'public', 'hq.html'));
   });
   ```
   `/sales` follows this exact shape. There is no server-side auth on page
   routes — every page is publicly *served* and guards itself client-side by
   checking its token and calling an authenticated API. Mirror that; do not
   invent a new pattern.
2. ⚠️ **`requireBranchAccess`** — `data/server.js:2328`:
   ```js
   if (['agency_admin', 'admin'].includes(role)) return next();
   if (!targetBranch || businessId === targetBranch) return next();
   return res.status(403)...
   ```
   A `sales` rep matches neither branch, so every `requireBranchAccess` endpoint
   returns 403 for them. **That is correct and must stay that way — see S2.**
3. **`GET /api/businesses/:id/setup-status`** — `data/routes/extras.js:114`,
   guarded `requireAuth, requireBranchAccess`. Returns `menuDone`, `qrDone`,
   `whatsappConnected`, `hasFirstOrder` (+ `dismissed`). Reps **cannot** call
   it (fact 2). SD5 wraps the same information in a rep-scoped endpoint instead.
4. **Trial data** lives on the business record in `data/businesses.json`:
   `trialEndsAt` (ISO date), `subscriptionStatus`, `subscriptionPlan`/`plan`.
   Days-left math already exists at `data/routes/business.js:340`:
   ```js
   Math.max(0, Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 86400000))
   ```
   Reuse that expression; don't re-derive it differently.
5. **Plan prices** — `data/plans.json`: starter 1500, growth 3000, pro 5000,
   each `duration_days: 30`, each with a `features` array and optional `badge`.
   HQ reads it via `GET /api/plans` — check that route exists before assuming;
   otherwise read the file server-side and expose it (do NOT fetch the raw JSON
   file from the browser).
6. **Sales collateral already in `public/`** (real filenames, verified):
   `Zordic-Pitch.pptx`, `Zordic-Pitch-Mobile.pdf`, `Zordic-Sales-Call-Guide.pdf`,
   `Zordic-Sales-Call-Cheatsheet.pdf`, `Zordic-Owner-Guide.pdf`, plus the
   `/pitch` route → `public/pitch.html`.
   ⚠️ These are named **Zordic**, not Zordical — deliberate, pending the domain
   cutover. **Do not rename them or "fix" the spelling.**
7. **`toIsoZ`** — on `routeCtx` (`data/server.js`). Every SQLite timestamp
   returned by a new endpoint must pass through it, or browsers render it ~5.5h
   off in IST. Platform-wide fix from 2026-08-02 — do not regress it.
8. **Frontend conventions** — see `public/hq.html`: token in
   `localStorage.getItem('cafehq_token')`, `fetch` with
   `{'Authorization':'Bearer '+token}`, `esc()` for HTML escaping,
   `toLocaleString('en-IN')` for ₹, CSS custom properties (`var(--ink-2)`,
   `var(--sage)`, `var(--rose)`, `var(--bg)`). Reuse the same design tokens so
   `/sales` looks like the rest of the platform.

## §2 — STOP RULES

- **S1 — Reps see only their own data.** Every rep-facing endpoint filters by
  `req.staff.id` **server-side**. A client-side filter is not a control. If you
  find yourself passing a rep id from the browser to identify *which* rep's data
  to return, that's wrong — take it from the token.
- **S2 — NEVER add `sales` to `requireBranchAccess`.** It guards café customer
  lists, chat history, orders, revenue and billing across the whole app. Adding
  `sales` there would hand every rep full access to every tenant's data in one
  line. When a rep needs café info, build a **dedicated, ownership-filtered
  endpoint** (SD5) — never widen the shared guard.
- **S3 — No new tenant surface.** The dashboard shows a rep: their leads, their
  commission, and setup/trial *flags* for cafés they signed. Not customers, not
  chat logs, not order contents, not revenue of the café itself.
- **S4 — Don't touch the foundation.** If a foundation endpoint is missing or
  returns a different shape than §0 expects, stop and report — don't patch it
  from here.
- **S5 — Money is display-only here.** Render the stored `commission_amount`.
  Never recompute a rate, never multiply anything by 0.10/0.05 in this package.
- **S6 — Mobile first.** Reps use this on a phone, standing in a café. Every
  view must be usable at 375px wide. Test at that width before claiming done.
- **S7 — Test data stays.** Leave test cafés/leads in place. Stage only source
  files — never `data/businesses.json`, never `data/z*/`.
- **S8 — Verify honestly.** `node -c` every touched `.js`; load the real page in
  a browser for every screen you build. Report what you actually checked.

---

## SD0 — `/sales` shell, auth guard, impersonation banner

1. `data/server.js` — add the page route beside the others (~line 209):
   ```js
   app.get('/sales', (req, res) => {
     res.sendFile(path.join(ROOT_DIR, 'public', 'sales.html'));
   });
   ```
2. `public/sales.html` — new page. Structure: header (rep name, logout), a
   simple nav (tabs or bottom bar — mobile first, S6), content area.
3. **Client-side guard**: on load, read the token; if absent → redirect to
   `/admin-login`. Then `GET /api/auth/me` (`data/routes/auth.js:222` returns
   `{ id, businessId, name, role }`); if `role !== 'sales'`, redirect away.
   Never trust a role value stored in localStorage — always confirm via the API.
4. **Token key**: SF6 stores the impersonation token under its own key so the
   admin's `cafehq_token` survives. Read **that** key first, falling back to the
   normal rep login key. Match whatever key SF6 actually used — check
   `public/hq.html` for the exact string rather than guessing.
5. **Impersonation banner**: if the decoded token / `/api/auth/me` response
   indicates `impersonatedBy`, show a persistent, visually distinct bar:
   *"Viewing as {rep name} — you are an admin"* with a "Return to HQ" button
   that clears the impersonation token and navigates to `/hq`. This must be
   impossible to miss; an admin who forgets they're impersonating will misread
   everything on the page.
   - If `/api/auth/me` doesn't echo `impersonatedBy`, add it there (that route
     returns a hand-picked subset of `req.staff`).

**Check:** visit `/sales` logged out → redirected. As a café manager → redirected.
As a rep → page loads with their name.

---

## SD1 — My Leads

1. `GET /api/crm-leads` already scopes to the caller when role is `sales`
   (SF1). No new endpoint needed — just call it.
2. Table/card list: café name, owner, phone, location, status pill, follow-up
   date, notes. On mobile, cards beat a wide table — collapse to one card per
   lead below ~600px.
3. Inline edit → `PUT /api/crm-leads/:id` (SF1 already blocks editing someone
   else's, and strips `assigned_to` for reps).
4. Status pills use `GET /api/lead-statuses` for colours **if** that route was
   widened to `sales` in SF1 — §1/SF1 says status routes stay admin-only, so if
   it 403s, ship a sensible default palette client-side rather than widening the
   route. Note in your report which happened.
5. Tap-to-call the lead's phone (`<a href="tel:...">`) — they're in the field.
6. Search + status filter, client-side over the already-fetched list.

## SD2 — Today's Follow-ups

1. Same data as SD1, filtered client-side: `follow_up_date <= today`.
2. Two groups: **Overdue** (before today) and **Today**. Overdue styled with
   `var(--rose)`, matching HQ's existing overdue treatment.
3. Make this the **default landing view** — it's the screen that drives the job.
4. Show a count badge in the nav.

## SD3 — Add Lead + Convert

1. **Add**: a short form → `POST /api/crm-leads`. SF1 forces `assigned_to` to
   the caller for reps, so don't send it. Only `cafe_name` is required.
2. **Convert**: on a lead, a "Convert to café" action that opens `/onboard` (the
   existing self-serve signup) in a new tab, then — once the operator/rep has
   the new `businessId` — calls
   `POST /api/crm-leads/:id/link-business` (SF2) to stamp attribution.
   - The onboard flow does not currently hand the businessId back. Simplest
     honest approach: after onboarding, show a small "Link signed café" input on
     the lead where the rep pastes/selects the new café id, then call the
     endpoint. **Do not fabricate an automatic handoff that doesn't exist.**
   - Surface the SF2 409 ("already linked") as a clear message, not a silent
     failure.
3. Remind in the UI copy that commission only starts once the café actually
   pays — reps should not expect a number here at signup time.

## SD4 — My Earnings

**New rep-facing endpoint required** (the foundation only built admin-side and
db-level helpers):

1. `GET /api/sales/me/earnings`, `requireAuth, requireRole('sales')`, in
   `data/routes/leads.js`:
   - rep id comes from `req.staff.id` **only** (S1)
   - returns `db.getRepCommissionSummary(req.staff.id)` plus
     `db.listPaymentsForRep(req.staff.id)` as a line-item list
   - each line: café name (resolve from `businesses`), amount, plan, `paid_at`,
     `commission_rate`, `commission_amount`, `is_first_payment`
   - all timestamps through `toIsoZ` (§1.7)
2. UI: headline numbers (this month, lifetime), then the line-item list showing
   **why** each rate applied — e.g. a `New client · 10%` vs `Retention · 5%`
   pill. A rep who can't see why they earned what they earned will not trust it.
3. State plainly in the UI that these are **earned** figures, not "paid out to
   you" — payout tracking doesn't exist yet (§4).
4. Empty state: "No commission yet — it starts when your first café pays after
   their trial."

## SD5 — My Signed Cafés

**New rep-facing endpoint required. Read S2 first — do not reuse
`/setup-status` and do not widen `requireBranchAccess`.**

1. `GET /api/sales/me/cafes`, `requireAuth, requireRole('sales')`:
   - filter the in-memory `businesses` array to `b.salesRepId === req.staff.id`
   - for each, return **only**: `id`, `name`, `location`, `subscriptionStatus`,
     `plan`, `trialEndsAt`, `trialDaysLeft` (use the §1.4 expression), setup
     flags (`menuDone`, `qrDone`, `whatsappConnected`, `hasFirstOrder` — reuse
     the logic from `data/routes/extras.js:114-138`, ideally by extracting it
     into a small shared helper rather than copy-pasting), and whether the café
     has any payments yet
   - **nothing else** — no customer counts, no revenue, no chat data (S3)
2. UI: one card per café. Show setup as a checklist so a stalled onboarding is
   obvious at a glance, and show trial countdown prominently (that's the moment
   the rep needs to chase the conversion — and their 10%).
3. Sort by urgency: trials ending soonest first, incomplete setup above complete.

## SD6 — Pitch Kit + Pricing

1. **Pitch Kit** — a simple list of links to the real files (§1.6, exact
   filenames, do not rename): the pitch deck (`/pitch` live version and
   `Zordic-Pitch-Mobile.pdf` for offline), `Zordic-Sales-Call-Guide.pdf`,
   `Zordic-Sales-Call-Cheatsheet.pdf`, `Zordic-Owner-Guide.pdf`.
   These are static files already served from `public/` — plain `<a>` links,
   no new endpoint.
2. **Pricing** — render the three plans from `plans.json` (§1.5) with price,
   what's included, and the 30-day trial terms, so reps quote correctly and
   consistently. Read it server-side; don't fetch the JSON file directly from
   the browser.
3. Both are read-only reference screens. Keep them simple.

---

## §3 — Finishing

1. `node -c` on every touched `.js`.
2. Load `/sales` in a real browser as a real `sales` account and click through
   **every** screen. Check the console for errors. Then resize to **375px** and
   do it again (S6).
3. **Negative test, report the result explicitly:** logged in as a rep, call a
   café endpoint directly and confirm it is refused, e.g.
   `GET /api/businesses/<someCafeId>/crm` → expect **403**. If it returns data,
   **stop immediately and report** — something widened `requireBranchAccess`.
4. `git status` — stage only source: `data/server.js`, `data/routes/*.js`,
   `public/sales.html`. Never `data/businesses.json`, never `data/z*/`.
5. Commit (per package or one clear commit), ending with:
   `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`
6. Push `origin master`, then hand the user the deploy line — **you have no
   server access, do not attempt to deploy:**
   ```
   cd ~/zordical && git pull origin master && pm2 restart zordical --update-env && sleep 3 && git log -1 --oneline && pm2 logs zordical --lines 15 --nostream
   ```
7. Report honestly: what you loaded and clicked, what the negative test returned,
   what you couldn't test, and anything you skipped.

## §4 — Out of scope

Commission **payout** tracking (marking commission as paid to a rep), clawback on
refund or cancellation, a sales-manager role that sees all reps, rep-to-rep lead
reassignment, notifications/reminders to reps, and any change to café-facing UI
or the manager portal.

If the operator asks for "mark commission paid", that's a new package — it needs
its own table (payout batches) and should not be bolted onto `payments`, whose
rows are deliberately immutable.
