// Run: node data/check_auth.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'cafe_hq.db');
if (!fs.existsSync(DB_PATH)) { console.log('✗ No cafe_hq.db — server has never started with new code'); process.exit(1); }

const db = new Database(DB_PATH);

console.log('\n=== Businesses ===');
db.prepare('SELECT id, name FROM businesses').all().forEach(b => console.log(' ✓', b.id, '—', b.name));

console.log('\n=== Staff accounts ===');
const staff = db.prepare('SELECT id, business_id, username, role, active FROM staff').all();
if (!staff.length) {
  console.log(' ✗ NO STAFF FOUND — owner was never seeded');
  console.log('\n→ Fix: restart server.js (the seeder runs on boot)');
} else {
  staff.forEach(s => console.log(` ✓ username="${s.username}" role=${s.role} branch=${s.business_id} active=${s.active}`));
}

console.log('\n=== Quick login test ===');
const bcrypt = require('bcryptjs');
const owner = db.prepare("SELECT * FROM staff WHERE username='owner' LIMIT 1").get();
if (owner) {
  const ok = bcrypt.compareSync('cafe1234', owner.password_hash);
  console.log(' Password "cafe1234":', ok ? '✓ CORRECT' : '✗ WRONG — password was changed');
} else {
  console.log(' No owner account found');
}

db.close();
