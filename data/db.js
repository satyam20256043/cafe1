// ─────────────────────────────────────────────────────────────────────────────
// db.js — SQLite Database Module for Zordic California
// Place this file in your project root (same folder as server.js)
// ─────────────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// This file already lives in the data/ directory — do NOT join another 'data'
// segment here. That bug used to make this module read/write a phantom
// data/data/cafe_hq.db that server.js and every route module never saw,
// while migrateFromJSON() silently failed to find businesses.json (wrong
// path) and left the `businesses` table empty, which then made every order
// insert fail its FOREIGN KEY constraint and crash the whole process.
const DATA_DIR = __dirname;
const DB_PATH  = path.join(DATA_DIR, 'cafe_hq.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Shared phone normalization ────────────────────────────────────────────────
// Canonical form used everywhere a phone number is stored or looked up: strip
// everything but digits, keep the last 10 (drops country codes like 91/+91).
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '').slice(-10);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    location TEXT,
    timings  TEXT,
    contact  TEXT,
    map      TEXT,
    wifi     TEXT,
    review   TEXT,
    status   TEXT DEFAULT 'online',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS staff (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'owner',
    active        INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, username)
  );
  -- Add missing columns to existing DBs
  -- (SQLite ignores errors from ALTER TABLE in db.exec only via pragma)

  CREATE TABLE IF NOT EXISTS customers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id  TEXT NOT NULL,
    phone        TEXT NOT NULL,
    name         TEXT,
    visits       INTEGER DEFAULT 0,
    last_intent  TEXT,
    loyalty_tier TEXT DEFAULT 'New',
    tags         TEXT DEFAULT '[]',
    notes        TEXT,
    total_spent  REAL DEFAULT 0,
    birthday     TEXT,
    last_seen    DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, phone)
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    category    TEXT DEFAULT 'General',
    price       REAL NOT NULL,
    discount    INTEGER DEFAULT 0,
    description TEXT,
    available   INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name        TEXT,
    phone       TEXT,
    guests      INTEGER DEFAULT 1,
    datetime    TEXT,
    status      TEXT DEFAULT 'pending',
    notes       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    customer_name TEXT,
    phone         TEXT,
    rating        INTEGER DEFAULT 5,
    comment       TEXT,
    source        TEXT DEFAULT 'web',
    coupon_code   TEXT,
    reply         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS offers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id       TEXT NOT NULL,
    phone             TEXT,
    customer_name     TEXT,
    requested_item    TEXT,
    status            TEXT DEFAULT 'pending',
    approved_discount INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    business_id       TEXT PRIMARY KEY,
    auto_pilot_active INTEGER DEFAULT 0,
    gbp_linked        INTEGER DEFAULT 0,
    gbp_place_id      TEXT,
    loyalty_enabled   INTEGER DEFAULT 1,
    loyalty_ratio     INTEGER DEFAULT 10,
    points_per_visit  INTEGER DEFAULT 5
  );

  -- loyalty_points: see Phase 3 schema block below

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT,
    staff_id    TEXT,
    staff_name  TEXT,
    action      TEXT,
    details     TEXT,
    ip          TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS backups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT,
    size_kb    INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Business Intelligence event log — append-only record of every meaningful
  -- action, so future AI features (churn, forecasting, personalization) have
  -- history to learn from instead of starting from zero.
  CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id    TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    customer_phone TEXT,
    actor          TEXT,
    metadata       TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_events_biz_time  ON events(business_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_biz_type  ON events(business_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_events_biz_phone ON events(business_id, customer_phone);

  -- Coupons — every offer/campaign issues one of these instead of a bare
  -- string discount code, so "campaign sent -> redeemed -> revenue" becomes
  -- provable attribution data instead of a guess.
  CREATE TABLE IF NOT EXISTS coupons (
    id               TEXT PRIMARY KEY,
    business_id      TEXT NOT NULL,
    code             TEXT NOT NULL,
    source_type      TEXT NOT NULL,   -- ai_campaign|offer_request|feedback5|review|winback|birthday|autopilot
    source_id        TEXT,
    customer_phone   TEXT,
    discount_type    TEXT NOT NULL,   -- percent|flat|free_item
    discount_value   REAL DEFAULT 0,
    status           TEXT DEFAULT 'issued',  -- issued|redeemed|expired
    issued_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at       DATETIME,
    redeemed_at      DATETIME,
    order_id         TEXT,
    redeemed_revenue REAL,
    UNIQUE(business_id, code)
  );
  CREATE INDEX IF NOT EXISTS idx_coupons_biz_status ON coupons(business_id, status);

  CREATE TABLE IF NOT EXISTS escalations (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL,
    customer_phone    TEXT,
    customer_name     TEXT,
    category          TEXT NOT NULL,   -- complaint_refund|large_booking|payment_dispute|unanswerable
    customer_message  TEXT,
    ai_suggestion     TEXT,
    status            TEXT DEFAULT 'pending',   -- pending|resolved
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at       DATETIME,
    resolved_by       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_escalations_biz_status ON escalations(business_id, status);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL, phone TEXT NOT NULL,
    customer_name TEXT, direction TEXT NOT NULL,   -- in|out
    message TEXT NOT NULL, channel TEXT DEFAULT 'whatsapp',  -- whatsapp|web|simulator
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_chat_biz ON chat_messages(business_id, phone, created_at);
`);


// Phase 3 tables created early so prepared statements below succeed (loyalty_points must exist before stmts.getLoyalty is prepared)
db.exec(`
  CREATE TABLE IF NOT EXISTS loyalty_points (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    phone       TEXT NOT NULL,
    customer_name TEXT,
    points      INTEGER DEFAULT 0,
    stamps      INTEGER DEFAULT 0,
    tier        TEXT DEFAULT 'New',
    birthday    TEXT,
    total_spent REAL DEFAULT 0,
    visits      INTEGER DEFAULT 0,
    last_visit  DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, phone)
  );

  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    phone       TEXT NOT NULL,
    type        TEXT NOT NULL,
    points      INTEGER DEFAULT 0,
    stamps      INTEGER DEFAULT 0,
    description TEXT,
    order_id    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_loyalty_biz   ON loyalty_points(business_id);
  CREATE INDEX IF NOT EXISTS idx_loyalty_phone ON loyalty_points(business_id, phone);
  CREATE INDEX IF NOT EXISTS idx_loyalty_bday  ON loyalty_points(birthday);

  CREATE TABLE IF NOT EXISTS password_reset_otps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id    TEXT NOT NULL,
    code        TEXT NOT NULL,
    expires_at  DATETIME NOT NULL,
    used        INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_otp_staff ON password_reset_otps(staff_id, code);
`);

// ── Safe column migrations (handles existing DBs missing columns) ─────────────
(function migrateColumns() {
  const cols = [
    // Staff
    ['staff',  'active',              'INTEGER DEFAULT 1'],
    ['staff',  'created_at',          "DATETIME DEFAULT CURRENT_TIMESTAMP"],
    ['staff',  'phone',               'TEXT'],
    // Orders
    ['orders', 'table_no',            'TEXT'],
    ['orders', 'order_type',          "TEXT DEFAULT 'dine_in'"],
    ['orders', 'discount',            'REAL DEFAULT 0'],
    ['orders', 'tax',                 'REAL DEFAULT 0'],
    ['orders', 'payment_status',      "TEXT DEFAULT 'pending'"],
    ['orders', 'payment_method',      "TEXT DEFAULT 'cash'"],
    ['orders', 'razorpay_order_id',   'TEXT'],
    ['orders', 'razorpay_payment_id', 'TEXT'],
    ['orders', 'notes',               'TEXT'],
    ['orders', 'updated_at',          'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    // Loyalty Phase 3 columns (for DBs created before Phase 3)
    ['loyalty_points', 'customer_name',    'TEXT'],
    ['loyalty_points', 'stamps',           'INTEGER DEFAULT 0'],
    ['loyalty_points', 'total_stamps',     'INTEGER DEFAULT 0'],
    ['loyalty_points', 'redeemed_stamps',  'INTEGER DEFAULT 0'],
    ['loyalty_points', 'tier',             "TEXT DEFAULT 'New'"],
    ['loyalty_points', 'birthday',         'TEXT'],
    ['loyalty_points', 'total_spent',      'REAL DEFAULT 0'],
    ['loyalty_points', 'visits',           'INTEGER DEFAULT 0'],
    ['loyalty_points', 'last_visit',       'DATETIME'], ['feedback','order_id','TEXT'],
    // Backups table: columns logBackup() writes (older schema only had filename/size_kb)
    ['backups', 'path',    'TEXT'],
    ['backups', 'size_mb', 'REAL'],
    ['backups', 'status',  'TEXT'],
  ];
  cols.forEach(([tbl, col, def]) => {
    try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`).run(); }
    catch(e) { /* column already exists or table not yet created — ignore */ }
  });
  // Ensure loyalty_transactions table exists (for old DBs)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id          TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      phone       TEXT NOT NULL,
      type        TEXT NOT NULL,
      points      INTEGER DEFAULT 0,
      stamps      INTEGER DEFAULT 0,
      description TEXT,
      order_id    TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch(e) {}
  // Ensure existing staff rows have active=1
  try { db.prepare('UPDATE staff SET active=1 WHERE active IS NULL').run(); } catch {}
})();

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  // Businesses
  getAllBusinesses:    db.prepare('SELECT * FROM businesses ORDER BY created_at'),
  getBusinessById:    db.prepare('SELECT * FROM businesses WHERE id = ?'),
  insertBusiness:     db.prepare('INSERT OR REPLACE INTO businesses (id,name,location,timings,contact,map,wifi,review,status) VALUES (?,?,?,?,?,?,?,?,?)'),
  updateBusiness:     db.prepare('UPDATE businesses SET name=?,location=?,timings=?,contact=?,map=?,wifi=?,review=?,status=? WHERE id=?'),

  // Staff
  getStaffByUsername: db.prepare('SELECT * FROM staff WHERE business_id = ? AND username = ?'),
  getStaffByBranch:   db.prepare('SELECT * FROM staff WHERE business_id = ?'),
  insertStaff:        db.prepare('INSERT INTO staff (business_id,username,password_hash,name,role) VALUES (?,?,?,?,?)'),
  updateStaffPassword:db.prepare('UPDATE staff SET password_hash=? WHERE id=?'),

  // Customers
  getCustomers:       db.prepare('SELECT * FROM customers WHERE business_id=? ORDER BY visits DESC'),
  getCustomer:        db.prepare('SELECT * FROM customers WHERE business_id=? AND phone=?'),
  upsertCustomer:     db.prepare(`INSERT INTO customers (business_id,phone,name,visits,last_intent,loyalty_tier,tags,last_seen)
                                  VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                                  ON CONFLICT(business_id,phone) DO UPDATE SET
                                  name=COALESCE(excluded.name,name),
                                  visits=visits+excluded.visits,
                                  last_intent=COALESCE(excluded.last_intent,last_intent),
                                  loyalty_tier=CASE WHEN excluded.loyalty_tier IS NULL OR excluded.loyalty_tier IN ('New','New Customer') THEN loyalty_tier ELSE excluded.loyalty_tier END,
                                  last_seen=CURRENT_TIMESTAMP`),

  // Menu
  getMenu:            db.prepare('SELECT * FROM menu_items WHERE business_id=? ORDER BY category,name'),
  insertMenuItem:     db.prepare('INSERT INTO menu_items (business_id,name,category,price,discount,description) VALUES (?,?,?,?,?,?)'),
  updateMenuItem:     db.prepare('UPDATE menu_items SET name=?,category=?,price=?,discount=?,description=?,available=? WHERE id=? AND business_id=?'),
  deleteMenuItem:     db.prepare('DELETE FROM menu_items WHERE id=? AND business_id=?'),

  // Reservations
  getReservations:    db.prepare('SELECT * FROM reservations WHERE business_id=? ORDER BY created_at DESC'),
  insertReservation:  db.prepare('INSERT INTO reservations (id,business_id,name,phone,guests,datetime) VALUES (?,?,?,?,?,?)'),
  updateReservation:  db.prepare('UPDATE reservations SET status=? WHERE id=? AND business_id=?'),

  // Feedback
  getFeedback:        db.prepare('SELECT * FROM feedback WHERE business_id=? ORDER BY created_at DESC'),
  insertFeedback:     db.prepare('INSERT INTO feedback (id,business_id,customer_name,phone,rating,comment,source,coupon_code) VALUES (?,?,?,?,?,?,?,?)'),
  updateFeedbackReply:db.prepare('UPDATE feedback SET reply=? WHERE id=? AND business_id=?'),

  // Offers
  getOffers:          db.prepare('SELECT * FROM offers WHERE business_id=? ORDER BY created_at DESC'),
  insertOffer:        db.prepare('INSERT INTO offers (business_id,phone,customer_name,requested_item) VALUES (?,?,?,?)'),
  updateOffer:        db.prepare('UPDATE offers SET status=?,approved_discount=? WHERE id=? AND business_id=?'),

  // Settings
  getSettings:        db.prepare('SELECT * FROM settings WHERE business_id=?'),
  upsertSettings:     db.prepare(`INSERT INTO settings (business_id,auto_pilot_active,loyalty_enabled) VALUES (?,?,1)
                                  ON CONFLICT(business_id) DO UPDATE SET auto_pilot_active=excluded.auto_pilot_active`),

  // Loyalty (basic lookup only — full loyalty handled by Phase 3 helpers)
  getLoyalty:         db.prepare('SELECT * FROM loyalty_points WHERE business_id=? AND phone=?'),

  // Audit log
  insertAudit:        db.prepare('INSERT INTO audit_log (business_id,staff_id,staff_name,action,details,ip) VALUES (?,?,?,?,?,?)'),
  getAuditLog:        db.prepare('SELECT * FROM audit_log WHERE business_id=? ORDER BY created_at DESC LIMIT 100'),

  // Analytics
  getAnalytics:       db.prepare(`SELECT
    (SELECT COUNT(*) FROM reservations WHERE business_id=? AND date(created_at)=date('now')) as today_reservations,
    (SELECT COUNT(*) FROM feedback    WHERE business_id=? AND date(created_at)=date('now')) as today_feedback,
    (SELECT COUNT(*) FROM customers   WHERE business_id=?)                                  as total_customers,
    (SELECT ROUND(AVG(rating),1) FROM feedback WHERE business_id=?)                        as avg_rating,
    (SELECT COUNT(*) FROM customers WHERE business_id=? AND loyalty_tier IN ('VIP','Elite')) as vip_count`),
};

// ── Helper: migrate existing JSON data to SQLite ──────────────────────────────
function migrateFromJSON() {
  const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
  if (!fs.existsSync(BUSINESSES_FILE)) return;

  const existing = stmts.getAllBusinesses.all();
  if (existing.length > 0) return; // already migrated

  console.log('[DB] Migrating JSON data to SQLite...');
  try {
    const businesses = JSON.parse(fs.readFileSync(BUSINESSES_FILE, 'utf-8'));
    const migrateTx = db.transaction(() => {
      businesses.forEach(b => {
        // The businesses row is the one insert every other table's FOREIGN KEY
        // depends on (orders, etc.) — it must NEVER be rolled back by a later
        // failure in this branch's optional JSON files, so it isn't wrapped in
        // the same try/catch as the rest.
        stmts.insertBusiness.run(b.id, b.name, b.location, b.timings, b.contact, b.map||'', b.wifi||'', b.review||'', b.status||'online');

        // Menu
        try {
          const menuFile = path.join(DATA_DIR, b.id, 'menu.json');
          if (fs.existsSync(menuFile)) {
            const menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
            menu.forEach(item => stmts.insertMenuItem.run(b.id, item.name, item.category||'General', item.price||0, item.discount||0, item.description||''));
          }
        } catch (e) { console.error(`[DB] Migration: menu import failed for ${b.id}:`, e.message); }

        // Reservations — ids in the seed JSON (e.g. 'r1','r2') are only unique
        // per branch, but the reservations table's id is a global PRIMARY KEY,
        // so prefix with the branch id to avoid cross-branch collisions.
        try {
          const resFile = path.join(DATA_DIR, b.id, 'reservations.json');
          if (fs.existsSync(resFile)) {
            const res = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
            res.forEach(r => stmts.insertReservation.run(`${b.id}_${r.id || Date.now() + '_' + Math.random()}`, b.id, r.name, r.phone, r.guests||1, r.datetime));
          }
        } catch (e) { console.error(`[DB] Migration: reservations import failed for ${b.id}:`, e.message); }

        // Feedback — same cross-branch id collision risk as reservations.
        try {
          const fbFile = path.join(DATA_DIR, b.id, 'feedback.json');
          if (fs.existsSync(fbFile)) {
            const fb = JSON.parse(fs.readFileSync(fbFile, 'utf-8'));
            fb.forEach(f => stmts.insertFeedback.run(`${b.id}_${f.id || Date.now() + '_' + Math.random()}`, b.id, f.customerName, f.phone, f.rating||5, f.comment, f.source||'web', f.couponCode||null));
          }
        } catch (e) { console.error(`[DB] Migration: feedback import failed for ${b.id}:`, e.message); }

        // CRM
        try {
          const crmFile = path.join(DATA_DIR, b.id, 'customer_profiles.json');
          if (fs.existsSync(crmFile)) {
            const crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8'));
            crm.forEach(c => stmts.upsertCustomer.run(b.id, c.phone, c.name||'', c.visits||0, c.lastIntent||'', c.loyaltyTier||'New', JSON.stringify(c.tags||[])));
          }
        } catch (e) { console.error(`[DB] Migration: customer profiles import failed for ${b.id}:`, e.message); }

        // Settings
        try {
          const setFile = path.join(DATA_DIR, b.id, 'settings.json');
          if (fs.existsSync(setFile)) {
            const s = JSON.parse(fs.readFileSync(setFile, 'utf-8'));
            stmts.upsertSettings.run(b.id, s.autoPilotActive ? 1 : 0);
          } else {
            stmts.upsertSettings.run(b.id, 0);
          }
        } catch (e) { console.error(`[DB] Migration: settings import failed for ${b.id}:`, e.message); }
      });
    });
    migrateTx();
    console.log(`[DB] Migration complete — ${businesses.length} branches imported.`);
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
}

// ── Helper: analytics ─────────────────────────────────────────────────────────
function getAnalytics(businessId) {
  return stmts.getAnalytics.get(businessId, businessId, businessId, businessId, businessId);
}

// ── Helper: loyalty tier ─────────────────────────────────────────────────────
function getLoyaltyTier(visits) {
  if (visits >= 10) return 'Elite';
  if (visits >= 5)  return 'VIP';
  if (visits >= 2)  return 'Regular';
  return 'New';
}

// ── Helper: audit log ────────────────────────────────────────────────────────
function audit(businessId, staffId, staffName, action, details, ip='') {
  stmts.insertAudit.run(businessId, staffId, staffName, action, typeof details==='object'?JSON.stringify(details):details, ip);
}

// Run migration on startup
migrateFromJSON();

module.exports = { db, stmts, getAnalytics, getLoyaltyTier, audit, normalizePhone };

// ── Raw DB access (for backup.js) ────────────────────────────────────────────
function raw() { return db; }

// ── Additional staff helpers (needed by auth.js) ─────────────────────────────
function getStaffByUsername(businessId, username) {
  return db.prepare('SELECT * FROM staff WHERE business_id=? AND username=? LIMIT 1')
           .get(businessId, username);
}
// Keeps the minimal SQLite `businesses` row (used for the orders FK and other
// SQL joins) in sync with the full record in businesses.json. Every business
// creation/update path must call this — without it, orders.business_id's
// FOREIGN KEY constraint fails for any business that only ever existed in
// businesses.json (this was the case for every /api/onboard and quick-add
// business until this fix — every order for a newly created café crashed).
function upsertBusinessRow(b) {
  stmts.insertBusiness.run(
    b.id, b.name, b.location || '', b.timings || '', b.contact || '',
    b.map || '', b.wifi || '', b.review || '', b.status || 'online'
  );
}
function getStaffById(id) {
  return db.prepare('SELECT * FROM staff WHERE id=? LIMIT 1').get(id);
}
// Agency-wide login: matches by username only, restricted to platform-operator
// roles (never used for café staff, who must always match their own business_id).
function getAdminStaffByUsername(username) {
  return db.prepare("SELECT * FROM staff WHERE username=? AND role IN ('agency_admin','admin') LIMIT 1")
           .get(username);
}
function listStaff(businessId) {
  return db.prepare('SELECT * FROM staff WHERE business_id=? ORDER BY role, name').all(businessId);
}
function createStaff({ businessId, name, username, passwordHash, role, phone }) {
  const textId = `staff_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  let finalId;
  try {
    // Try TEXT primary key (Phase 1+ schema)
    db.prepare(`INSERT INTO staff (id,business_id,name,username,password_hash,role,phone,active,created_at)
                VALUES (?,?,?,?,?,?,?,1,datetime('now'))`)
      .run(textId, businessId, name, username, passwordHash, role, phone || null);
    finalId = textId;
  } catch(e) {
    if (e.message && (e.message.includes('datatype mismatch') || e.message.includes('UNIQUE'))) {
      // Old schema: INTEGER PK AUTOINCREMENT — don't specify id
      db.prepare(`INSERT OR IGNORE INTO staff (business_id,name,username,password_hash,role,phone,active)
                  VALUES (?,?,?,?,?,?,1)`)
        .run(businessId, name, username, passwordHash, role, phone || null);
      const row = db.prepare('SELECT id FROM staff WHERE business_id=? AND username=? LIMIT 1').get(businessId, username);
      finalId = row ? row.id : null;
    } else throw e;
  }
  return getStaffById(finalId);
}
function updateStaffPassword(id, passwordHash) {
  db.prepare('UPDATE staff SET password_hash=? WHERE id=?').run(passwordHash, id);
}
function setStaffActive(id, active) {
  db.prepare('UPDATE staff SET active=? WHERE id=?').run(active ? 1 : 0, id);
}
function logBackup({ filename, path: bPath, sizeMb, status }) {
  // id is INTEGER PK AUTOINCREMENT — let SQLite assign it; size_kb kept for old-schema readers
  db.prepare(`INSERT INTO backups (filename,path,size_mb,size_kb,status,created_at)
              VALUES (?,?,?,?,?,datetime('now'))`)
    .run(filename, bPath || '', sizeMb || 0, Math.round((sizeMb || 0) * 1024), status || 'success');
}

// ── Password reset OTPs (WhatsApp-delivered) ─────────────────────────────────
function createPasswordResetOtp(staffId, code, expiresAt) {
  db.prepare('INSERT INTO password_reset_otps (staff_id,code,expires_at) VALUES (?,?,?)').run(staffId, code, expiresAt);
}
function getValidPasswordResetOtp(staffId, code) {
  return db.prepare(`SELECT * FROM password_reset_otps
                      WHERE staff_id=? AND code=? AND used=0 AND expires_at > datetime('now')
                      ORDER BY id DESC LIMIT 1`).get(staffId, code);
}
function consumePasswordResetOtp(id) {
  db.prepare('UPDATE password_reset_otps SET used=1 WHERE id=?').run(id);
}

// Re-export with all helpers
Object.assign(module.exports, {
  raw, getStaffByUsername, getAdminStaffByUsername, getStaffById, listStaff,
  createStaff, updateStaffPassword, setStaffActive, logBackup,
  createPasswordResetOtp, getValidPasswordResetOtp, consumePasswordResetOtp,
  upsertBusinessRow,
  migrateFromJSON,
});

// ── Phase 2: Orders schema migration ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    table_no      TEXT,
    order_type    TEXT DEFAULT 'dine_in',  -- dine_in | takeaway | delivery
    items         TEXT NOT NULL,           -- JSON array
    subtotal      REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    tax           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    status        TEXT DEFAULT 'pending',  -- pending|confirmed|preparing|ready|served|cancelled
    payment_status TEXT DEFAULT 'pending', -- pending|paid|failed|refunded
    payment_method TEXT DEFAULT 'cash',   -- cash|razorpay|upi
    razorpay_order_id  TEXT,
    razorpay_payment_id TEXT,
    notes         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(business_id) REFERENCES businesses(id)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_business ON orders(business_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(business_id, status);
`);

// ── Order helpers ─────────────────────────────────────────────────────────────
function createOrder({ businessId, customerName, customerPhone, tableNo, orderType, items, subtotal, discount, tax, total, notes, paymentMethod }) {
  const id = `ord_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  db.prepare(`
    INSERT INTO orders
      (id,business_id,customer_name,customer_phone,table_no,order_type,items,subtotal,discount,tax,total,notes,payment_method,status,payment_status,created_at,updated_at)
    VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','pending',datetime('now'),datetime('now'))
  `).run(id, businessId, customerName, customerPhone||'', tableNo||'', orderType||'dine_in',
         JSON.stringify(items), subtotal, discount||0, tax, total, notes||'', paymentMethod||'cash');
  return getOrderById(id);
}

function getOrderById(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (o) o.items = JSON.parse(o.items || '[]');
  return o;
}

function listOrders(businessId, { status, limit=50, offset=0 } = {}) {
  let q = 'SELECT * FROM orders WHERE business_id=?';
  const params = [businessId];
  if (status) { q += ' AND status=?'; params.push(status); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(q).all(...params).map(o => ({ ...o, items: JSON.parse(o.items||'[]') }));
}

function updateOrderStatus(id, status) {
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
  return getOrderById(id);
}

function updateOrderPayment(id, { paymentStatus, paymentMethod, razorpayOrderId, razorpayPaymentId }) {
  db.prepare(`UPDATE orders SET payment_status=?, payment_method=?,
    razorpay_order_id=COALESCE(?,razorpay_order_id),
    razorpay_payment_id=COALESCE(?,razorpay_payment_id),
    updated_at=datetime('now') WHERE id=?`)
    .run(paymentStatus, paymentMethod, razorpayOrderId||null, razorpayPaymentId||null, id);
  return getOrderById(id);
}

function getRevenueStats(businessId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN date(created_at)=date('now') AND payment_status='paid' THEN total ELSE 0 END),0)          AS today_revenue,
      COUNT(CASE WHEN date(created_at)=date('now') THEN 1 END)                                                          AS today_orders,
      COALESCE(SUM(CASE WHEN date(created_at)>=date('now','-7 days') AND payment_status='paid' THEN total ELSE 0 END),0) AS week_revenue,
      COUNT(CASE WHEN date(created_at)>=date('now','-7 days') THEN 1 END)                                               AS week_orders,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m',created_at)=strftime('%Y-%m','now') AND payment_status='paid' THEN total ELSE 0 END),0) AS month_revenue,
      COUNT(CASE WHEN strftime('%Y-%m',created_at)=strftime('%Y-%m','now') THEN 1 END)                                  AS month_orders,
      COUNT(CASE WHEN status='pending' THEN 1 END)                                                                       AS pending_count,
      COUNT(CASE WHEN status='preparing' THEN 1 END)                                                                     AS preparing_count
    FROM orders WHERE business_id=?
  `).get(businessId);
  return row;
}

function getDailyRevenue(businessId, days=14) {
  return db.prepare(`
    SELECT date(created_at) AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(CASE WHEN payment_status='paid' THEN total ELSE 0 END),0) AS revenue
    FROM orders WHERE business_id=? AND date(created_at)>=date('now','-'||?||' days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(businessId, days);
}

// Average paid revenue per weekday over the last N days — the basis for the
// weekly growth suggestion (G4). Returns per-weekday totals plus how many
// times each weekday actually occurred in the window (not just days/7, since
// the window rarely divides evenly), so averages are accurate either way.
function getWeekdayRevenue(businessId, days=28) {
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', created_at) AS INTEGER) AS weekday,
           COALESCE(SUM(CASE WHEN payment_status='paid' THEN total ELSE 0 END),0) AS revenue,
           COUNT(CASE WHEN payment_status='paid' THEN 1 END) AS orders
    FROM orders WHERE business_id=? AND date(created_at)>=date('now','-'||?||' days')
    GROUP BY weekday
  `).all(businessId, days);

  const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const occurrences = [0,0,0,0,0,0,0];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    occurrences[d.getDay()]++;
  }

  const byWeekday = WEEKDAY_NAMES.map((name, idx) => {
    const row = rows.find(r => r.weekday === idx);
    const totalRevenue = row ? row.revenue : 0;
    const occ = occurrences[idx] || 1;
    return { weekday: idx, name, totalRevenue, occurrences: occ, avgRevenue: totalRevenue / occ };
  });

  const totalRevenue = byWeekday.reduce((s, w) => s + w.totalRevenue, 0);
  const overallDailyAvg = days ? totalRevenue / days : 0;

  return { byWeekday, overallDailyAvg, totalRevenue };
}

function getTopItems(businessId, limit=5) {
  // Parse JSON items and aggregate — done in JS since SQLite JSON_EACH requires extension
  const orders = db.prepare(
    "SELECT items FROM orders WHERE business_id=? AND payment_status='paid'"
  ).all(businessId);
  const counts = {};
  orders.forEach(o => {
    try {
      JSON.parse(o.items).forEach(item => {
        counts[item.name] = (counts[item.name]||0) + (item.qty||1);
      });
    } catch {}
  });
  return Object.entries(counts)
    .sort((a,b) => b[1]-a[1])
    .slice(0, limit)
    .map(([name,qty]) => ({ name, qty }));
}

Object.assign(module.exports, {
  createOrder, getOrderById, listOrders,
  updateOrderStatus, updateOrderPayment,
  getRevenueStats, getDailyRevenue, getWeekdayRevenue, getTopItems,
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3 — Loyalty Points Engine
// ══════════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS loyalty_points (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    phone       TEXT NOT NULL,
    customer_name TEXT,
    points      INTEGER DEFAULT 0,
    stamps      INTEGER DEFAULT 0,
    tier        TEXT DEFAULT 'New',
    birthday    TEXT,
    total_spent REAL DEFAULT 0,
    visits      INTEGER DEFAULT 0,
    last_visit  DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, phone)
  );

  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    phone       TEXT NOT NULL,
    type        TEXT NOT NULL,  -- earned | redeemed | adjusted | stamp
    points      INTEGER DEFAULT 0,
    stamps      INTEGER DEFAULT 0,
    description TEXT,
    order_id    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_loyalty_biz   ON loyalty_points(business_id);
  CREATE INDEX IF NOT EXISTS idx_loyalty_phone ON loyalty_points(business_id, phone);
  CREATE INDEX IF NOT EXISTS idx_loyalty_bday  ON loyalty_points(birthday);
`);

// ── Loyalty helpers ───────────────────────────────────────────────────────────
const POINTS_PER_RUPEE = 1;      // 1 point per ₹1 spent
const STAMPS_PER_VISIT = 1;      // 1 stamp per visit
const STAMPS_FOR_FREE  = 10;     // 10 stamps = free item
const POINTS_FOR_FREE  = 500;    // 500 points = ₹50 off

function loyaltyTier(points, visits) {
  if (visits >= 20 || points >= 2000) return 'Elite';
  if (visits >= 10 || points >= 1000) return 'VIP';
  if (visits >=  3 || points >=  200) return 'Regular';
  return 'New';
}

function getLoyaltyCard(businessId, phone) {
  return db.prepare('SELECT * FROM loyalty_points WHERE business_id=? AND phone=?').get(businessId, phone);
}

function getOrCreateCard(businessId, phone, name) {
  let card = getLoyaltyCard(businessId, phone);
  if (!card) {
    const textId = `loy_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    try {
      // Phase 3 schema: TEXT primary key + full columns
      db.prepare(`INSERT INTO loyalty_points
        (id,business_id,phone,customer_name,points,stamps,tier,visits,last_visit)
        VALUES (?,?,?,?,0,0,'New',0,datetime('now'))`)
        .run(textId, businessId, phone, name || 'Customer');
    } catch(e) {
      if (e.message && (e.message.includes('datatype mismatch') || e.message.includes('no column'))) {
        // Old schema: INTEGER PK AUTOINCREMENT — let DB auto-assign id
        try {
          db.prepare(`INSERT OR IGNORE INTO loyalty_points (business_id,phone,customer_name,points)
            VALUES (?,?,?,0)`)
            .run(businessId, phone, name || 'Customer');
        } catch(e2) {
          // Absolute fallback — minimal insert
          db.prepare(`INSERT OR IGNORE INTO loyalty_points (business_id,phone) VALUES (?,?)`)
            .run(businessId, phone);
        }
      } else throw e;
    }
    card = getLoyaltyCard(businessId, phone);
  }
  // Update name if missing
  if (card && name && !card.customer_name) {
    try { db.prepare('UPDATE loyalty_points SET customer_name=? WHERE business_id=? AND phone=?').run(name, businessId, phone); }
    catch(e) {}
    card = getLoyaltyCard(businessId, phone);
  }
  return card;
}

function awardPoints(businessId, phone, name, amountSpent, orderId) {
  const card   = getOrCreateCard(businessId, phone, name);
  const earned = Math.floor(amountSpent * POINTS_PER_RUPEE);
  const newPts = card.points + earned;
  const newVis = card.visits + 1;
  const newStamps = Math.min(card.stamps + STAMPS_PER_VISIT, 99);
  const tier   = loyaltyTier(newPts, newVis);

  db.prepare(`UPDATE loyalty_points SET
    points=?, stamps=?, tier=?, visits=?, total_spent=total_spent+?,
    customer_name=COALESCE(?,customer_name), last_visit=datetime('now')
    WHERE business_id=? AND phone=?`)
    .run(newPts, newStamps, tier, newVis, amountSpent, name||null, businessId, phone);

  // Log transaction
  const txId = `ltx_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
  db.prepare(`INSERT INTO loyalty_transactions
    (id,business_id,phone,type,points,stamps,description,order_id)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(txId, businessId, phone, 'earned', earned, STAMPS_PER_VISIT,
      `Earned ${earned} pts + 1 stamp on ₹${amountSpent} order`, orderId||null);

  return getLoyaltyCard(businessId, phone);
}

// Award a fixed bonus (no order, no stamp) — used for 5-star reviews, referrals, etc.
function getLoyaltyTransactions(businessId, phone, limit) {
  const p = phone.replace(/[^0-9]/g,'').slice(-10);
  const rows = db.prepare(
    `SELECT * FROM loyalty_transactions WHERE business_id=? AND phone=?
     ORDER BY created_at DESC LIMIT ?`
  ).all(businessId, p, limit || 20);
  return rows;
}

function awardBonusPoints(businessId, phone, name, bonusPoints, description) {
  const card   = getOrCreateCard(businessId, phone, name);
  const newPts = card.points + bonusPoints;
  const tier   = loyaltyTier(newPts, card.visits);

  db.prepare(`UPDATE loyalty_points SET
    points=?, tier=?, customer_name=COALESCE(?,customer_name)
    WHERE business_id=? AND phone=?`)
    .run(newPts, tier, name||null, businessId, phone);

  // Log transaction
  const txId = `ltx_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
  db.prepare(`INSERT INTO loyalty_transactions
    (id,business_id,phone,type,points,stamps,description,order_id)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(txId, businessId, phone, 'bonus', bonusPoints, 0,
      description || `Bonus +${bonusPoints} pts`, null);

  return getLoyaltyCard(businessId, phone);
}

function redeemStamps(businessId, phone) {
  const card = getLoyaltyCard(businessId, phone);
  if (!card || card.stamps < STAMPS_FOR_FREE) {
    return { success: false, message: `Need ${STAMPS_FOR_FREE} stamps. You have ${card?.stamps||0}.` };
  }
  db.prepare('UPDATE loyalty_points SET stamps=stamps-? WHERE business_id=? AND phone=?')
    .run(STAMPS_FOR_FREE, businessId, phone);
  const txId = `ltx_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
  db.prepare(`INSERT INTO loyalty_transactions
    (id,business_id,phone,type,stamps,description) VALUES (?,?,?,?,?,?)`)
    .run(txId, businessId, phone, 'redeemed', -STAMPS_FOR_FREE, '10 stamps redeemed — free item!');
  return { success: true, message: '🎉 Free item unlocked!' };
}

function redeemPoints(businessId, phone, pointsToRedeem) {
  const card = getLoyaltyCard(businessId, phone);
  if (!card || card.points < pointsToRedeem) {
    return { success: false, message: `Not enough points. Have ${card?.points||0}, need ${pointsToRedeem}.` };
  }
  db.prepare('UPDATE loyalty_points SET points=points-? WHERE business_id=? AND phone=?')
    .run(pointsToRedeem, businessId, phone);
  const discount = Math.floor(pointsToRedeem / (POINTS_PER_RUPEE * 10));
  const txId = `ltx_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
  db.prepare(`INSERT INTO loyalty_transactions
    (id,business_id,phone,type,points,description) VALUES (?,?,?,?,?,?)`)
    .run(txId, businessId, phone, 'redeemed', -pointsToRedeem,
      `${pointsToRedeem} pts redeemed — ₹${discount} discount`);
  return { success: true, discount, message: `₹${discount} discount applied!` };
}

function updateBirthday(businessId, phone, birthday) {
  db.prepare('UPDATE loyalty_points SET birthday=? WHERE business_id=? AND phone=?')
    .run(birthday, businessId, phone);
}

function getLoyaltyLeaderboard(businessId, limit=20) {
  return db.prepare(`SELECT * FROM loyalty_points
    WHERE business_id=? ORDER BY points DESC LIMIT ?`).all(businessId, limit);
}

function getUpcomingBirthdays(businessId, days=7) {
  // Match birthday (MM-DD) within next N days
  const rows = db.prepare(`SELECT * FROM loyalty_points WHERE business_id=? AND birthday IS NOT NULL`)
    .all(businessId);
  const today = new Date();
  return rows.filter(r => {
    if (!r.birthday) return false;
    const parts = r.birthday.split('-');
    if (parts.length < 2) return false;
    const [, mm, dd] = parts.length === 3 ? parts : ['', parts[0], parts[1]];
    const bday = new Date(today.getFullYear(), parseInt(mm)-1, parseInt(dd));
    if (bday < today) bday.setFullYear(today.getFullYear()+1);
    const diff = (bday - today) / (1000*60*60*24);
    return diff >= 0 && diff <= days;
  }).sort((a,b) => {
    const toDate = s => { const p=s.split('-'); return new Date(2000,parseInt(p[p.length-2])-1,parseInt(p[p.length-1])); };
    return toDate(a.birthday) - toDate(b.birthday);
  });
}

function getLoyaltyHistory(businessId, phone, limit=10) {
  return db.prepare(`SELECT * FROM loyalty_transactions
    WHERE business_id=? AND phone=? ORDER BY created_at DESC LIMIT ?`)
    .all(businessId, phone, limit);
}

Object.assign(module.exports, {
  getLoyaltyCard, getOrCreateCard, awardPoints, awardBonusPoints, getLoyaltyTransactions,
  redeemStamps, redeemPoints, updateBirthday,
  getLoyaltyLeaderboard, getUpcomingBirthdays, getLoyaltyHistory,
  STAMPS_FOR_FREE, POINTS_FOR_FREE,
});

// ── Business Intelligence event log ───────────────────────────────────────────
const logEventStmt = db.prepare(`
  INSERT INTO events (business_id, event_type, customer_phone, actor, metadata)
  VALUES (?, ?, ?, ?, ?)
`);

// Never throws — logging must not break the request that triggered it.
function logEvent(businessId, eventType, { customerPhone, actor, metadata } = {}) {
  try {
    logEventStmt.run(
      businessId,
      eventType,
      customerPhone ? normalizePhone(customerPhone) : null,
      actor || 'system',
      metadata !== undefined ? JSON.stringify(metadata) : null
    );
  } catch (e) {
    console.error('[events] logEvent failed:', e.message);
  }
}

function getEvents(businessId, { type, from, to, limit = 200 } = {}) {
  let q = 'SELECT * FROM events WHERE business_id = ?';
  const params = [businessId];
  if (type) { q += ' AND event_type = ?'; params.push(type); }
  if (from) { q += ' AND created_at >= ?'; params.push(from); }
  if (to)   { q += ' AND created_at <= ?'; params.push(to); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(q).all(...params).map(r => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
}

// Agency-wide roll-up across all businesses (for HQ).
function getAllEvents({ type, from, to, limit = 200 } = {}) {
  let q = 'SELECT * FROM events WHERE 1=1';
  const params = [];
  if (type) { q += ' AND event_type = ?'; params.push(type); }
  if (from) { q += ' AND created_at >= ?'; params.push(from); }
  if (to)   { q += ' AND created_at <= ?'; params.push(to); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(q).all(...params).map(r => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
}

Object.assign(module.exports, { logEvent, getEvents, getAllEvents });

// ── Coupons & attribution ──────────────────────────────────────────────────────
const insertCouponStmt = db.prepare(`
  INSERT INTO coupons (id, business_id, code, source_type, source_id, customer_phone,
                        discount_type, discount_value, status, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)
`);
const getCouponStmt = db.prepare(`SELECT * FROM coupons WHERE business_id = ? AND code = ?`);
const redeemCouponStmt = db.prepare(`
  UPDATE coupons SET status = 'redeemed', redeemed_at = datetime('now'), order_id = ?, redeemed_revenue = ?
  WHERE business_id = ? AND code = ? AND status = 'issued'
`);

function generateCouponCode(sourceType) {
  const prefixMap = {
    ai_campaign: 'AI', offer_request: 'OFR', feedback5: 'THX', review: 'REV',
    winback: 'WIN', birthday: 'BDAY', autopilot: 'AUTO',
  };
  const prefix = prefixMap[sourceType] || 'ZRD';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${suffix}`;
}

// { businessId, sourceType, sourceId, customerPhone, discountType, discountValue, expiresInDays }
function issueCoupon({ businessId, sourceType, sourceId, customerPhone, discountType, discountValue, expiresInDays = 14 }) {
  const id = `cpn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let code, attempt = 0;
  // Retry on the rare code collision (UNIQUE(business_id, code))
  while (true) {
    code = generateCouponCode(sourceType);
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
    try {
      insertCouponStmt.run(id, businessId, code, sourceType, sourceId || null,
        customerPhone ? normalizePhone(customerPhone) : null, discountType || 'percent',
        discountValue || 0, expiresAt);
      break;
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE') && attempt++ < 5) continue;
      throw e;
    }
  }
  logEvent(businessId, 'coupon.issued', {
    customerPhone, actor: 'system',
    metadata: { code, sourceType, sourceId: sourceId || null, discountType, discountValue },
  });
  return { id, code, businessId, sourceType, discountType, discountValue };
}

// Returns { valid, coupon?, reason? } — never throws; safe to call from a
// customer-facing "apply coupon" flow.
function validateCoupon(businessId, code) {
  if (!code) return { valid: false, reason: 'No code provided' };
  const coupon = getCouponStmt.get(businessId, String(code).trim().toUpperCase());
  if (!coupon) return { valid: false, reason: 'Coupon not found' };
  if (coupon.status === 'redeemed') return { valid: false, reason: 'Coupon already redeemed' };
  if (coupon.status === 'expired') return { valid: false, reason: 'Coupon expired' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { valid: false, reason: 'Coupon expired' };
  }
  return { valid: true, coupon };
}

// Marks a coupon redeemed against a specific order. Idempotent-safe: only
// transitions status from 'issued' -> 'redeemed' (a second call is a no-op).
function redeemCoupon(businessId, code, orderId, orderRevenue) {
  const check = validateCoupon(businessId, code);
  if (!check.valid) return { success: false, reason: check.reason };
  const result = redeemCouponStmt.run(orderId, orderRevenue || 0, businessId, String(code).trim().toUpperCase());
  if (result.changes === 0) return { success: false, reason: 'Coupon already redeemed' };
  logEvent(businessId, 'coupon.redeemed', {
    customerPhone: check.coupon.customer_phone, actor: 'customer',
    metadata: { code, orderId, revenue: orderRevenue, sourceType: check.coupon.source_type },
  });
  return { success: true, coupon: check.coupon, discountType: check.coupon.discount_type, discountValue: check.coupon.discount_value };
}

// Attribution rollup: per source_type (and source_id when present), how many
// coupons were issued vs redeemed, the revenue they produced, and a simple
// ROI = attributed revenue / (discount cost estimated from redeemed coupons).
function getAttributionReport(businessId, { from, to } = {}) {
  let q = `SELECT source_type, source_id, status, discount_type, discount_value, redeemed_revenue
           FROM coupons WHERE business_id = ?`;
  const params = [businessId];
  if (from) { q += ' AND issued_at >= ?'; params.push(from); }
  if (to)   { q += ' AND issued_at <= ?'; params.push(to); }
  const rows = db.prepare(q).all(...params);

  const bySource = {};
  for (const r of rows) {
    const key = r.source_id ? `${r.source_type}:${r.source_id}` : r.source_type;
    if (!bySource[key]) {
      bySource[key] = { sourceType: r.source_type, sourceId: r.source_id, issued: 0, redeemed: 0, revenue: 0, discountCost: 0 };
    }
    const b = bySource[key];
    b.issued += 1;
    if (r.status === 'redeemed') {
      b.redeemed += 1;
      b.revenue += r.redeemed_revenue || 0;
      b.discountCost += r.discount_type === 'flat' ? (r.discount_value || 0)
        : r.discount_type === 'percent' ? (r.redeemed_revenue || 0) * (r.discount_value || 0) / 100
        : 0;
    }
  }

  return Object.values(bySource).map(b => ({
    ...b,
    redemptionRate: b.issued ? Math.round((b.redeemed / b.issued) * 1000) / 10 : 0,
    roi: b.discountCost > 0 ? Math.round((b.revenue / b.discountCost) * 100) / 100 : (b.revenue > 0 ? null : 0),
  }));
}

Object.assign(module.exports, { issueCoupon, validateCoupon, redeemCoupon, getAttributionReport });

// ── AI escalations ────────────────────────────────────────────────────────────
const insertEscalationStmt = db.prepare(`
  INSERT INTO escalations (id, business_id, customer_phone, customer_name, category,
                            customer_message, ai_suggestion)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const listEscalationsStmt = db.prepare(`
  SELECT * FROM escalations WHERE business_id = ? AND status = ? ORDER BY created_at DESC
`);
const listAllEscalationsStmt = db.prepare(`
  SELECT * FROM escalations WHERE business_id = ? ORDER BY created_at DESC
`);
const resolveEscalationStmt = db.prepare(`
  UPDATE escalations SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?
  WHERE id = ? AND business_id = ? AND status = 'pending'
`);

function createEscalation({ businessId, customerPhone, customerName, category, customerMessage, aiSuggestion }) {
  const id = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  insertEscalationStmt.run(
    id, businessId, customerPhone ? normalizePhone(customerPhone) : null,
    customerName || null, category, customerMessage || null, aiSuggestion || null
  );
  logEvent(businessId, 'escalation.created', {
    customerPhone, actor: 'ai',
    metadata: { category, message: customerMessage },
  });
  return { id, businessId, category, customerPhone, customerName, customerMessage, aiSuggestion, status: 'pending' };
}

function listEscalations(businessId, status) {
  return status ? listEscalationsStmt.all(businessId, status) : listAllEscalationsStmt.all(businessId);
}

// Returns { success, escalation? } — never throws; safe for a route handler.
function resolveEscalation(businessId, id, staffId) {
  const result = resolveEscalationStmt.run(staffId || 'staff', id, businessId);
  if (result.changes === 0) return { success: false };
  logEvent(businessId, 'escalation.resolved', { actor: staffId ? `staff:${staffId}` : 'staff', metadata: { escalationId: id } });
  return { success: true };
}

Object.assign(module.exports, { createEscalation, listEscalations, resolveEscalation });

// ── Chat message log ──────────────────────────────────────────────────────────
// Persisted for every AI conversation channel (WhatsApp webhook, web widget,
// manager chat simulator) so the manager/owner can browse full history.
const insertChatMessageStmt = db.prepare(`
  INSERT INTO chat_messages (business_id, phone, customer_name, direction, message, channel)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function saveChatMessage(businessId, phone, customerName, direction, message, channel) {
  try {
    insertChatMessageStmt.run(
      businessId, phone ? normalizePhone(phone) : '',
      customerName || null, direction, message || '', channel || 'whatsapp'
    );
  } catch (e) { console.error('[chat_messages] insert failed:', e.message); }
}

Object.assign(module.exports, { saveChatMessage });
