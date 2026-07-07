// reset_manager_pw.js
// Inspects + fixes the 'manager' staff account for businessId='indiranagar'
// in the live SQLite DB, then tests login + dashboard access via the running server.

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'cafe_hq.db');
const db = new Database(DB_PATH);

console.log('=== Staff records for indiranagar (BEFORE) ===');
const before = db.prepare('SELECT id, business_id, name, username, role, active FROM staff WHERE business_id = ?').all('indiranagar');
console.log(JSON.stringify(before, null, 2));

const NEW_PASSWORD = 'manager1234';
const newHash = bcrypt.hashSync(NEW_PASSWORD, 10);

const mgr = before.find(r => r.username === 'manager');
if (mgr) {
  db.prepare('UPDATE staff SET password_hash = ?, role = ?, active = 1 WHERE id = ?')
    .run(newHash, 'manager', mgr.id);
  console.log('\nUpdated existing account id=' + mgr.id + '. Old role was "' + mgr.role + '". New password="manager1234", role="manager", active=1.');
} else {
  const newId = 'staff_mgr_' + Date.now();
  db.prepare('INSERT INTO staff (id, business_id, name, username, password_hash, role, active) VALUES (?,?,?,?,?,?,1)')
    .run(newId, 'indiranagar', 'Arjun Mehta', 'manager', newHash, 'manager');
  console.log('\nNo manager account existed for indiranagar. Created new account id=' + newId + ' with password="manager1234", role="manager".');
}

console.log('\n=== Staff records for indiranagar (AFTER) ===');
const after = db.prepare('SELECT id, business_id, name, username, role, active FROM staff WHERE business_id = ?').all('indiranagar');
console.log(JSON.stringify(after, null, 2));

db.close();

// ---- Live login + access test against the running server ----
(async () => {
  try {
    const resp = await fetch('http://localhost:3010/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId: 'indiranagar', username: 'manager', password: NEW_PASSWORD })
    });
    const data = await resp.json();
    console.log('\n=== Login test (manager / indiranagar / manager1234) ===');
    console.log('HTTP status:', resp.status);
    console.log(JSON.stringify(data, null, 2));

    if (data.token) {
      const headers = { Authorization: 'Bearer ' + data.token };

      const r2 = await fetch('http://localhost:3010/api/businesses/indiranagar/orders', { headers });
      const t2 = await r2.text();
      console.log('\n[GET /api/businesses/indiranagar/orders] status:', r2.status);
      console.log(t2.slice(0, 300));

      const r3 = await fetch('http://localhost:3010/api/staff', { headers });
      const t3 = await r3.text();
      console.log('\n[GET /api/staff] status:', r3.status);
      console.log(t3.slice(0, 300));

      const r4 = await fetch('http://localhost:3010/api/auth/me', { headers });
      const t4 = await r4.text();
      console.log('\n[GET /api/auth/me] status:', r4.status);
      console.log(t4.slice(0, 300));
    }
  } catch (e) {
    console.log('\nLogin test ERROR:', e.message);
    console.log('(Is the server running on port 3010?)');
  }
})();
