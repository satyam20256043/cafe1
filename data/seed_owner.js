// node data/seed_owner.js
// Creates / resets owner accounts for ALL branches in businesses.json

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DB_PATH  = path.join(__dirname, 'cafe_hq.db');
const BIZ_FILE = path.join(__dirname, 'businesses.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure staff table exists
db.exec(`
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
`);

const PASSWORD = 'cafe1234';
const hash     = bcrypt.hashSync(PASSWORD, 10);

const businesses = JSON.parse(fs.readFileSync(BIZ_FILE, 'utf8'));

console.log('\n☕  Seeding owner accounts...\n');
let created = 0, reset = 0;

businesses.forEach(b => {
  const existing = db.prepare(
    'SELECT id FROM staff WHERE business_id=? AND username=?'
  ).get(b.id, 'owner');

  if (existing) {
    db.prepare('UPDATE staff SET password_hash=?, active=1, role=? WHERE business_id=? AND username=?')
      .run(hash, 'owner', b.id, 'owner');
    console.log(`  ↻  Reset  owner @ ${b.id}  (${b.name})`);
    reset++;
  } else {
    const id = 'owner_' + b.id + '_' + Date.now();
    db.prepare(`INSERT INTO staff (id,business_id,name,username,password_hash,role,active)
                VALUES (?,?,?,?,?,?,1)`)
      .run(id, b.id, b.ownerName || 'Owner', 'owner', hash, 'owner');
    console.log(`  ✓  Created owner @ ${b.id}  (${b.name})`);
    created++;
  }
});

db.close();

console.log(`
════════════════════════════════════════
  ✅  Done — ${created} created, ${reset} reset

  Owner Portal:  http://localhost:3010/owner.html
  Username:      owner
  Password:      cafe1234
  Branch:        pick any branch from the dropdown
════════════════════════════════════════
`);
