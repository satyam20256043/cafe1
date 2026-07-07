// node data/fix_db.js  — fixes missing columns + seeds owner accounts
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const db = new Database(path.join(__dirname, 'cafe_hq.db'));
db.pragma('journal_mode = WAL');

// ── Add missing columns safely ────────────────────────────────────────────────
const addCol = (table, col, def) => {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    console.log(`✓ Added column ${table}.${col}`);
  } catch(e) {
    if (e.message.includes('duplicate column')) {
      console.log(`  ${table}.${col} already exists`);
    } else {
      console.log(`  ${table}.${col}: ${e.message}`);
    }
  }
};

addCol('staff', 'active',     'INTEGER DEFAULT 1');
addCol('staff', 'created_at', "DATETIME DEFAULT CURRENT_TIMESTAMP");
addCol('orders', 'table_no',  'TEXT');
addCol('orders', 'order_type','TEXT DEFAULT "dine_in"');
addCol('orders', 'discount',  'REAL DEFAULT 0');
addCol('orders', 'tax',       'REAL DEFAULT 0');
addCol('orders', 'payment_status', 'TEXT DEFAULT "pending"');
addCol('orders', 'payment_method', 'TEXT DEFAULT "cash"');
addCol('orders', 'razorpay_order_id', 'TEXT');
addCol('orders', 'razorpay_payment_id', 'TEXT');
addCol('orders', 'notes',     'TEXT');
addCol('orders', 'updated_at','DATETIME DEFAULT CURRENT_TIMESTAMP');

// ── Create orders table if missing ───────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL,
  customer_name TEXT NOT NULL, customer_phone TEXT, table_no TEXT,
  order_type TEXT DEFAULT 'dine_in', items TEXT NOT NULL DEFAULT '[]',
  subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, tax REAL DEFAULT 0,
  total REAL DEFAULT 0, status TEXT DEFAULT 'pending',
  payment_status TEXT DEFAULT 'pending', payment_method TEXT DEFAULT 'cash',
  razorpay_order_id TEXT, razorpay_payment_id TEXT, notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`);

// ── Set all existing staff as active ────────────────────────────────────────
db.prepare('UPDATE staff SET active=1 WHERE active IS NULL').run();

// ── Seed owner for both branches ─────────────────────────────────────────────
const hash = bcrypt.hashSync('cafe1234', 10);
['indiranagar','koramangala'].forEach(bid => {
  db.prepare(`
    INSERT INTO staff (id,business_id,name,username,password_hash,role,active)
    VALUES (?,?,?,?,?,?,1)
    ON CONFLICT(business_id,username) DO UPDATE SET
      password_hash=excluded.password_hash, active=1
  `).run(`owner_${bid}`, bid, 'Owner', 'owner', hash, 'owner');
  console.log(`✓ Owner seeded for ${bid}`);
});

// ── Verify ────────────────────────────────────────────────────────────────────
const staff = db.prepare('SELECT business_id,username,role,active FROM staff').all();
console.log('\n=== Staff in DB ===');
staff.forEach(s => console.log(`  ${s.username} @ ${s.business_id} | role=${s.role} active=${s.active}`));

const test = db.prepare('SELECT * FROM staff WHERE business_id=? AND username=? AND active=1 LIMIT 1').get('indiranagar','owner');
const ok   = test && bcrypt.compareSync('cafe1234', test.password_hash);
console.log('\nLogin test:', ok ? '✓ PASS — ready to login!' : '✗ FAIL');
console.log('\n→ Restart server: node server.js');
console.log('→ Login at: http://localhost:3010/login');
console.log('  Branch:   The Roasted Bean');
console.log('  Username: owner  |  Password: cafe1234\n');
db.close();
