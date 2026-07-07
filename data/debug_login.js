// node data/debug_login.js
// Full diagnosis + auto-fix

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = path.join(__dirname, 'cafe_hq.db');
console.log('DB path:', DB_PATH);
console.log('DB exists:', fs.existsSync(DB_PATH));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 1. Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY, name TEXT, location TEXT, timings TEXT,
    contact TEXT, map TEXT, wifi TEXT, review TEXT, status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL,
    name TEXT NOT NULL, username TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT DEFAULT 'owner',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, username)
  );
`);

// 2. Ensure businesses exist
const bizCount = db.prepare('SELECT COUNT(*) as c FROM businesses').get().c;
if (bizCount === 0) {
  db.prepare("INSERT OR IGNORE INTO businesses (id,name,status) VALUES ('indiranagar','The Roasted Bean','online')").run();
  db.prepare("INSERT OR IGNORE INTO businesses (id,name,status) VALUES ('koramangala','Mocha & Co.','online')").run();
  console.log('\n✓ Businesses inserted');
}

// 3. Show all staff
const allStaff = db.prepare('SELECT business_id, username, role, active FROM staff').all();
console.log('\n=== Staff in DB ===');
if (!allStaff.length) console.log('  (empty)');
allStaff.forEach(s => console.log(`  business_id="${s.business_id}" username="${s.username}" role=${s.role} active=${s.active}`));

// 4. Force-create/reset owner for both branches
const PASSWORD = 'cafe1234';
const hash = bcrypt.hashSync(PASSWORD, 10);
['indiranagar','koramangala'].forEach(bid => {
  db.prepare(`
    INSERT INTO staff (id,business_id,name,username,password_hash,role,active)
    VALUES (?,?,?,?,?,?,1)
    ON CONFLICT(business_id,username) DO UPDATE SET password_hash=excluded.password_hash, active=1
  `).run(`owner_${bid}`, bid, 'Owner', 'owner', hash, 'owner');
});
console.log('\n✓ Owner accounts created/reset for both branches');

// 5. Verify lookup exactly as auth.js does it
console.log('\n=== Simulating auth.js lookup ===');
const test = db.prepare('SELECT * FROM staff WHERE business_id=? AND username=? LIMIT 1').get('indiranagar','owner');
if (!test) {
  console.log('✗ STILL NULL after insert — something is very wrong');
} else {
  const ok = bcrypt.compareSync('cafe1234', test.password_hash);
  console.log(`✓ Found: username=${test.username} role=${test.role} active=${test.active}`);
  console.log(`✓ Password "cafe1234" check: ${ok ? 'CORRECT' : 'WRONG'}`);
}

// 6. Check if server.js has auth route
const serverPath = path.join(__dirname, '..', 'server.js');
if (fs.existsSync(serverPath)) {
  const src = fs.readFileSync(serverPath, 'utf-8');
  console.log('\n=== server.js checks ===');
  console.log('Has /api/auth/login route:', src.includes("'/api/auth/login'") ? '✓ YES' : '✗ NO — still old server.js!');
  console.log('Has db require:           ', src.includes("require('./db')") ? '✓ YES' : '✗ NO');
  console.log('Total lines:              ', src.split('\n').length);
} else {
  console.log('\n✗ No server.js found in project root');
}

db.close();
console.log('\n════════════════════════════════════════');
console.log('Restart server: node server.js');
console.log('Login at:       http://localhost:3010/login');
console.log('Branch:         The Roasted Bean (indiranagar)');
console.log('Username:       owner');
console.log('Password:       cafe1234');
console.log('════════════════════════════════════════\n');
