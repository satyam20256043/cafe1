# ZORDIC LEADS PIPELINE GUIDE — v1.0 (for a Sonnet execution session)

Build a sales **Leads pipeline** into the private HQ admin panel: an editable, Excel-like
tracker of prospective cafés with a colour-coded status dropdown (plus custom statuses the
operator can add). Execute packages **LEAD0 → LEAD3 in order, committing after each**. Read
§0–§2 fully before touching any file. Decisions in §1 were made by the user on 2026-07-11 —
do **not** re-ask them.

**Status: NOT YET EXECUTED** (written 2026-07-11).

---

## 0. Context — read first

- **Zordic California** is a multi-tenant café SaaS, live at `https://zordic.in`. The `/hq*`
  admin panel is double-gated (Caddy HTTP Basic Auth + app admin login) and is the ONLY place
  with cross-tenant / operator visibility.
- **⚠️ REPO PATH CHANGED**: the local repo is now at **`C:\Users\SSJ\OneDrive\Desktop\cafe-ai-bot`**
  (Windows moved Desktop under OneDrive — the old `C:\Users\SSJ\Desktop\cafe-ai-bot` no longer
  resolves). All older docs/memory still say the old path; use the OneDrive one.
- Repo `github.com/satyam20256043/cafe1`, branch **`master`** only (GitHub default `main` is an
  unrelated scaffold — never use it). Deploy is a single line (the Lightsail browser SSH
  corrupts multi-line pastes):
  `cd ~/zordic && git pull origin master && pm2 restart zordic --update-env && pm2 logs zordic --lines 15 --nostream`
- **Work only in `data\` + `public\hq.html`.** Root `server.js` is a frozen legacy monolith.
- **What this feature is (and is NOT):** it tracks **prospects** — cafés you are pitching that
  have NOT signed up yet. That is different data from the tenant cafés in `businesses.json` /
  the `businesses` table. It gets its OWN storage. HQ's Data Sheets tab already has a read-only
  "📬 Leads" export pill — do NOT touch that; this is a separate, editable pipeline tab.

**Verified codebase facts (2026-07-11) — build on these:**
- HQ tabs are switched by `switchHQTab('<name>')` in `public/hq.html`. Existing tab names:
  `branches`, `datasheet`, `revenue`, `settings`, `staff`, `billing`, `activity`. You will add
  `leads`. Read hq.html first to copy the exact tab-button markup, the tab-content container
  pattern, the auth-header helper it uses for fetches, and its CSS tokens (espresso/gold, from
  `public/zordic-ui.css`: `--z-gold #C9A84C`, `--z-espresso #0D0705`, `--z-bg`, `--z-border`,
  `--z-success`, `--z-danger`).
- `data/routes/extras.js` destructures `requireAuth, requireRole` from ctx and has working
  `loadAgencySettings()`/`saveAgencySettings()`. Its admin endpoints use
  `requireRole('agency_admin')` (e.g. `GET/PUT /api/settings`). Match that exact role guard.
- Route modules receive the whole `db.js` exports object as `db` (the `ctx.db` gotcha). For
  ad-hoc SQL use `db.raw().prepare(...)`; PREFERRED is to add prepared-statement helper
  functions inside `db.js` and export them via `Object.assign(module.exports, {...})` (the
  coupons/escalations sections are the template).
- New route modules are registered in `data/server.js` as `require('./routes/<name>')(routeCtx)`.
  New shared functions must be added to `routeCtx` in server.js AND destructured in the module.
- Local server for testing must be launched via **Bash** (`node data/server.js`, port 3010),
  NOT the preview tool (its sandbox blocks outbound network — irrelevant here but it's the
  house rule; also `preview_click` is unreliable, use `element.click()` via `preview_eval`).

## 1. Locked user decisions (2026-07-11 — do not re-ask)

1. **New editable HQ tab "Leads"** (a sales pipeline), admin-only, separate from the existing
   read-only Data Sheets export.
2. **Columns:** café/restaurant name · phone number · owner's name · location · **status**
   (colour dropdown) · **next follow-up date** · **notes** (free text). The last two were an
   explicit user add-on — they make it a real closing tool, not just a list.
3. **Status dropdown** ships with defaults and supports **operator-added custom statuses**
   (an "+ Add status" button), persisted so every row's dropdown shows them. Defaults:
   `Prospect, Called, Messaged, Trial, Progressing, Paid, Lost`. Each status has a colour chip.
4. **Excel-like UX:** add row, delete row, click-to-edit cells with auto-save, search box,
   filter-by-status, sort, CSV **export** and CSV **import**.
5. **"Convert to café"** action on a lead → opens `/onboard` (prospect becomes a live café),
   then the lead is marked `Paid`.

## 2. Ground rules

- **Admin-only, every endpoint:** `requireAuth, requireRole('agency_admin')` (match extras.js).
  This data must NEVER be reachable by a café owner. hq.html is already behind the double gate.
- **No realtime needed** — single operator. Do NOT add socket events for this.
- **Storage is global (not per-tenant):** leads belong to the operator, not to any `business_id`.
  So NO `requireBranchAccess`, NO business_id column.
- Add db.js helpers + export them; register the new route module in server.js's routeCtx wiring.
- Money/tenant paths are untouched. Test-data hygiene per §4 before each commit.
- Match hq.html's existing look exactly — reuse its panel/table/button classes; don't invent a
  new visual language.

## 3. Work packages

### LEAD0 — Schema + db helpers
In `db.js`, add two tables (in the same `db.exec(\`...\`)` schema block style as `escalations`):
```sql
CREATE TABLE IF NOT EXISTS crm_leads (
  id TEXT PRIMARY KEY,
  cafe_name TEXT NOT NULL,
  phone TEXT,
  owner_name TEXT,
  location TEXT,
  status TEXT DEFAULT 'Prospect',
  follow_up_date TEXT,            -- YYYY-MM-DD, nullable
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status);
CREATE TABLE IF NOT EXISTS crm_lead_statuses (
  label TEXT PRIMARY KEY,
  color TEXT NOT NULL,           -- hex, e.g. #C9A84C
  is_default INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 100
);
```
On boot, **seed the 7 default statuses** if `crm_lead_statuses` is empty (idempotent
`INSERT OR IGNORE`), each with a sensible chip colour (e.g. Prospect grey, Called blue,
Messaged teal, Trial amber, Progressing gold, Paid green, Lost red) and `is_default=1`.

Add + export helpers: `createLead(fields)` (generates `id = lead_<ts>_<rand>`),
`listLeads()`, `updateLead(id, partialFields)` (whitelist columns; set `updated_at`),
`deleteLead(id)`, `listLeadStatuses()`, `addLeadStatus(label, color)`,
`deleteLeadStatus(label)` (refuse if `is_default=1`). Export via `Object.assign(module.exports, {...})`.
**Verify:** boot the server via Bash; confirm no schema errors and
`node -e "const {listLeadStatuses}=require('./data/db.js'); console.log(listLeadStatuses())"`
prints the 7 seeded statuses.
**Commit:** `LEAD0: crm_leads + crm_lead_statuses schema and db helpers`

### LEAD1 — Admin API (new route module)
Create `data/routes/leads.js` (module pattern: `module.exports = function register(ctx){ const {app, db, requireAuth, requireRole} = ctx; ... }`). Register it in `server.js`
alongside the other `require('./routes/xxx')(routeCtx)` calls. Endpoints (ALL
`requireAuth, requireRole('agency_admin')`):
- `GET  /api/leads` → `db.listLeads()`
- `POST /api/leads` `{cafe_name, phone?, owner_name?, location?, status?, follow_up_date?, notes?}` → create, return row (400 if no cafe_name)
- `PUT  /api/leads/:id` `{...partial}` → `db.updateLead`; 404 if not found
- `DELETE /api/leads/:id` → delete; return `{success}`
- `GET  /api/lead-statuses` → `db.listLeadStatuses()`
- `POST /api/lead-statuses` `{label, color}` → add custom (validate hex colour; 409 if label exists)
- `DELETE /api/lead-statuses/:label` → delete custom (403 if it's a default)
- `POST /api/leads/import` `{rows:[...]}` → bulk create, return count inserted
Guard every handler with `if(!db) return res.status(503)...`.
**Verify (Bash + curl):** log in as the admin (or a temp `agency_admin` staff row — never print
the real admin password), create a lead, list it, update its status, add a custom status
"Follow-up Fri", confirm it appears in `GET /api/lead-statuses`, delete a lead, try deleting a
default status (expect 403), import 2 rows.
**Commit:** `LEAD1: admin-only Leads pipeline CRUD + custom-status endpoints`

### LEAD2 — HQ "Leads" tab UI
In `public/hq.html`:
1. Add a `Leads` tab button in the hq-tab row (`onclick="switchHQTab('leads')"`) and a matching
   tab-content container; wire `switchHQTab` to call `loadLeads()` when `leads` is shown.
2. Toolbar: **+ Add Lead**, a search box, a **filter-by-status** dropdown, **Export CSV**,
   **Import CSV** (hidden file input), and **+ Add Status**.
3. Table columns: Café/Restaurant · Phone · Owner · Location · Status · Follow-up · Notes ·
   (delete). Every cell is an inline editable input/textarea that **auto-saves on change**
   (`PUT /api/leads/:id` with just the changed field); the Status cell is a `<select>` built
   from `GET /api/lead-statuses`, each option/chip colour-coded (render the selected status as a
   coloured pill). Follow-up is `<input type=date>`. Rows past their follow-up date get a subtle
   red left-border so overdue leads pop.
4. `+ Add Lead` inserts a blank row (creates via POST, then focuses the name cell).
   `+ Add Status` prompts for a label + colour (small inline form or a colour `<input type=color>`),
   POSTs it, and refreshes every row's dropdown.
5. Search filters client-side across all text columns; status filter narrows by status.
6. Export CSV is client-side from the loaded rows; Import CSV parses a simple CSV
   (header row: cafe_name,phone,owner_name,location,status,follow_up_date,notes) and POSTs to
   `/api/leads/import`, then reloads.
7. Use hq.html's existing auth-header/fetch helper (read the file — it already has one for its
   other admin fetches). Match existing panel/table/button classes and the espresso/gold tokens.
**Verify (Bash server + puppeteer/preview):** log into `/hq`, open Leads, add a lead inline,
change status (pill recolours), set a follow-up date (overdue border shows for a past date),
add a custom status and confirm it's selectable, search + filter work, export downloads a CSV,
import round-trips it back. Zero console errors. (Do NOT screenshot other cafés' private data.)
**Commit:** `LEAD2: HQ Leads pipeline tab — editable grid, custom statuses, CSV import/export`

### LEAD3 — "Convert to café" + regression/deploy
1. Add a **Convert** action per lead: opens `/onboard` in a new tab (optionally pre-filling
   `?name=&phone=&owner=` IF onboard.html is trivially extended to read those params — otherwise
   just open `/onboard` and let the operator complete it), then `PUT`s the lead to `status:'Paid'`.
   Keep prefill as a small optional stretch; the status flip is required.
2. Full local regression: the 8 default HQ tabs still work; Leads CRUD + custom status + CSV
   both directions; a café owner (manager role) hitting `/api/leads` gets 403 (prove the guard).
3. Test-data purge (§4). `git status` clean except the known `data/data/backups/*` artifact.
4. Push; give the user the single-line deploy; note nothing in the customer/owner apps changed.
5. Update this guide's Status line + session memory (`project-zordic-california.md`).
**Commit:** `LEAD3: convert-lead-to-cafe, admin-guard regression, deploy`

## 4. Testing protocol
- Launch the server via **Bash**: `node data/server.js` (port 3010). Admin auth: log in through
  `/api/auth/login` with the real admin, OR insert a temp `agency_admin` staff row
  (`business_id '_agency'`, bcryptjs hash) and delete it after — never use/print the real admin
  password.
- Leads have no `business_id`, so cleanup is simple: `DELETE FROM crm_leads WHERE cafe_name LIKE 'TEST%'`
  and remove any custom test statuses. No businesses.json / branch-folder churn involved.
- Before committing, confirm `git status` is clean apart from the pre-existing untracked
  `data/data/backups/*.db` files.

## 5. Out of scope — do not build
- Any customer/owner-facing exposure of leads (admin-only, forever).
- Per-lead activity history / email integration / reminders/notifications (a later phase — the
  follow-up date column is the lightweight version for now).
- Auto-import of signed-up cafés as leads, or two-way sync between leads and tenants (Convert is
  one-directional and manual by design).
- Realtime multi-user editing (single operator; no sockets).
